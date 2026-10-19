import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBookComicPlugin } from '../../src/metadata/book-comic-provider.js';
import { StorageRegistry, VirtualFileSystem, IdentityAccessMap } from '../../src/storage/index.js';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { MemoryStorageAdapter } from '../../src/storage/testing/memory-adapter.js';

const provenanceFile = new URL('./fixtures/book-comic/provenance.json', import.meta.url);
const provenance = JSON.parse(await readFile(provenanceFile)), folder = new URL('./', provenanceFile);
const native = JSON.parse(await readFile(new URL('native.json', folder)));
const input = JSON.parse(await readFile(new URL('input.json', folder)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceRoot = 'Z:\\ComicCoverOriginals';
const mimes = { Png: 'image/png', Jpg: 'image/jpeg', Bmp: 'image/bmp', Gif: 'image/gif', Webp: 'image/webp' };

test('Comic covers copy the actual native selected archive stream through real media VFS', async t => {
  const storage = new StorageRegistry(); storage.registerType('memory', () => new MemoryStorageAdapter());
  await storage.createInstance('media', 'memory', {});
  const vfs = new VirtualFileSystem(storage); vfs.mount({ path: '/media', instanceId: 'media', capabilities: { create: true, mkdir: true } });
  const identityMap = new IdentityAccessMap(); identityMap.addPrefix({ identityRoot: sourceRoot, accessRoot: '/media', style: 'windows', returnAccess: 'actual original archive bytes' });
  const spoolPath = await mkdtemp(path.join(os.tmpdir(), 'mm-comic-covers-'));
  const archives = new BookArchiveService({ vfs, identityMap, spoolPath });
  t.after(async () => { await archives.close(); assert.deepEqual(await readdir(spoolPath), []); await storage.close(); await rm(spoolPath, { recursive: true }); });
  for (const expected of native.covers) await t.test(expected.name, async () => {
    const sample = input.coverCases.find(row => row.name === expected.name), name = 'book' + (sample.extension ?? '.cbz');
    await vfs.mkdir('/media/' + sample.name);
    if (!sample.missing) {
      const asset = provenance.assets.find(row => row.path.replaceAll('\\', '/') === expected.path.replaceAll('\\', '/'));
      const bytes = await readFile(expected.path); assert.equal(hash(bytes), asset.sha256);
      await vfs.write('/media/' + sample.name + '/' + name, bytes, { overwrite: false });
    }
    const logs = [], [, provider] = createBookComicPlugin({ openArchive: archives.openArchive, culture: expected.culture,
      logger: { error() { logs.push('Error'); } } }).providers;
    const result = await provider.getImage({ Id: sample.name, Path: path.win32.join(sourceRoot, sample.name, name) },
      { type: sample.imageType ?? 'Primary', signal: sample.cancelled ? AbortSignal.abort() : undefined });
    assert.equal(Boolean(result), expected.hasImage);
    assert.deepEqual(logs, expected.logs.map(row => row.level));
    if (result) { assert.equal(result.mimeType, mimes[expected.format]); assert.equal(result.bytes.length, expected.bytes); assert.equal(hash(result.bytes), expected.sha256); }
    assert.deepEqual(await readdir(spoolPath), []);
  });
});

test('Comic cover closes its operation-owned archive after selection, read failure and cancellation', async () => {
  for (const failure of ['no-image', 'read', 'cancel', 'none']) {
    const events = [], entry = { key: failure === 'no-image' ? 'text.xml' : 'cover.png', size: 4, isDirectory: false };
    const signal = new AbortController();
    const [, provider] = createBookComicPlugin({ openArchive: async () => ({ entries: [entry],
      findEntry(key) { return key === entry.key ? entry : null; },
      async read(value, options) { assert.equal(value, entry); events.push('read');
        if (failure === 'read') throw new Error('Injected archive read failure.');
        if (failure === 'cancel') { signal.abort(); options.signal.throwIfAborted(); }
        return Buffer.from('copy'); },
      async close() { events.push('close'); } }) }).providers;
    const result = await provider.getImage({ Path: 'Z:\\missing-mapping\\book.cbz' }, { signal: signal.signal });
    assert.equal(Boolean(result), failure === 'none');
    assert.equal(events.at(-1), 'close'); assert.equal(events.filter(event => event === 'close').length, 1);
  }
});
