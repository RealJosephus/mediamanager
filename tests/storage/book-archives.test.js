import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BookArchiveService } from '../../src/storage/archive-reader.js';
import { IdentityAccessMap } from '../../src/storage/identity-mapping.js';
import { Worker } from 'node:worker_threads';

const fixture = new URL('../metadata/fixtures/book-opf-epub/', import.meta.url);
const provenance = new URL('../metadata/fixtures/book-opf-epub/provenance.json', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'book-archives-'));
  const identityMap = new IdentityAccessMap();
  const locations = new Map();
  const counts = { opened: 0, closed: 0 };
  const vfs = { async openRead(access, { signal } = {}) {
    counts.opened++;
    const stream = createReadStream(locations.get(access), { signal, highWaterMark: 32768 }); let closed = false;
    return { stream, async close() { if (!closed) { closed = true; counts.closed++; stream.destroy(); } } };
  } };
  const service = new BookArchiveService({ vfs, identityMap, spoolPath: path.join(directory, 'spool'), ...options });
  t.after(async () => {
    try {
      await service.close();
      assert.equal(counts.opened, counts.closed);
      try { assert.deepEqual(await fs.readdir(path.join(directory, 'spool')), []); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('book-archives-'));
      await fs.rm(directory, { recursive: true });
    }
  });
  const bind = filename => { identityMap.bind('book-archive', '/book-archive'); locations.set('/book-archive', filename); return { Id: 'book-archive', Path: 'Z:\\OriginalBooks\\not-the-host-path.epub' }; };
  return { service, bind, counts };
}

test('original-media archive access preserves the native ZIP directory, first lookup and selected bytes', async t => {
  await fs.stat(provenance);
  const native = JSON.parse(await fs.readFile(new URL('native.json', fixture)));
  const { service, bind } = await setup(t);
  for (const scenario of native.archiveResults) {
    await t.test(scenario.name, async () => {
      const filename = new URL('assets/archive/' + scenario.name + '.zip', fixture);
      const archive = await service.openArchive(bind(fileURLToPath(filename)), { zipOnly: true });
      try {
        assert.deepEqual(archive.entries.map(entry => ({ FullName: entry.key, Length: entry.size })), scenario.entries);
        for (const expected of scenario.queries) {
          const entry = archive.findEntry(expected.key);
          assert.equal(Boolean(entry), expected.found);
          if (entry) {
            assert.equal(digest(await archive.read(entry)), expected.sha);
            assert.equal(digest(await archive.read(entry)), expected.sha);
          }
        }
      } finally { await archive.close(); }
    });
  }
});

test('archive cancellation belongs to each read after the opening prefix', async t => {
  const { service, bind } = await setup(t);
  const controller = new AbortController();
  const archive = await service.openArchive(bind(fileURLToPath(new URL('assets/archive/local-central-name-mismatch.zip', fixture))),
    { signal: controller.signal, zipOnly: true });
  controller.abort(new Error('The opening request ended.'));
  assert.equal(digest(await archive.read(archive.entries[0])), '5acbfff1b086e0f920c5857527976199018afe0cbf16e28d42c7eb9c683508e5');
  await assert.rejects(archive.read(archive.entries[0], { signal: controller.signal }), /opening request ended/u);
  await archive.close();
  await assert.rejects(archive.read(archive.entries[0]), { code: 'closed' });
});

test('a terminal worker failure releases its spool and rejects repeated reads', async t => {
  let worker;
  const { service, bind } = await setup(t, { createWorker() {
    worker = new EventEmitter();
    worker.postMessage = () => {};
    worker.terminate = async () => 0;
    setImmediate(() => worker.emit('message', { id: 0, result: { entries: [{ key: 'cover.png', size: 1 }], comment: [] } }));
    return worker;
  } });
  const archive = await service.openArchive(bind(fileURLToPath(new URL('assets/archive/local-central-name-mismatch.zip', fixture))));
  const pending = archive.read(archive.entries[0]);
  worker.emit('error', new Error('Archive worker failed.'));
  await assert.rejects(pending, /worker failed/u);
  await assert.rejects(archive.read(archive.entries[0]), { code: 'closed' });
  await archive.close();
});

test('service close terminates owned readers and refuses new admission', async t => {
  const { service, bind } = await setup(t);
  const item = bind(fileURLToPath(new URL('assets/archive/local-central-name-mismatch.zip', fixture)));
  const archive = await service.openArchive(item, { zipOnly: true });
  await service.close(); await service.close();
  await assert.rejects(archive.read(archive.entries[0]), { code: 'closed' });
  await assert.rejects(service.openArchive(item), { code: 'closed' });
});

test('forced worker termination removes both original and actual derived encrypted-entry spools', { timeout: 10000 }, async t => {
  const comicProof = JSON.parse(await fs.readFile(new URL('../metadata/fixtures/book-comic/provenance.json', import.meta.url)));
  const source = comicProof.upstream.find(row => row.path.endsWith('/Rar.encrypted_filesOnly.rar'));
  assert.equal(digest(await fs.readFile(source.path)), source.sha256);
  let worker, sourceSpool, prepared;
  const preparation = new Promise(resolve => { prepared = resolve; });
  const { service, bind } = await setup(t, { createWorker(workerData) {
    sourceSpool = workerData.filename;
    worker = new Worker(new URL('./fixtures/book-archives/stalled-entry-worker.mjs', import.meta.url), { workerData, trackUnmanagedFds: true });
    worker.on('message', message => { if (message.notice === 'derived-ready') prepared(); });
    return worker;
  } });
  const archive = await service.openArchive(bind(source.path));
  const pending = archive.read(archive.entries[1]);
  const rejection = assert.rejects(pending, /worker|closed/iu);
  await preparation;
  assert.ok((await fs.stat(sourceSpool + '.entry')).size > 38976);
  await worker.terminate(); await rejection; await archive.close();
  await assert.rejects(fs.stat(sourceSpool), { code: 'ENOENT' });
  await assert.rejects(fs.stat(sourceSpool + '.entry'), { code: 'ENOENT' });
});
