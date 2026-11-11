import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { LocalAdapter } from '../../plugins/local/adapter.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { StorageRegistry } from '../../src/storage/registry.js';
import { validationOutputRoot } from '../../tools/validation/paths.js';

const outcome = operation => Promise.resolve(operation).then(value => ({ value }), error => ({ error }));
async function pending(operation) {
  let settled = false;
  void operation.then(() => { settled = true; }, () => { settled = true; });
  await immediate(); assert.equal(settled, false, 'An admitted next() still owns its real source descriptor.');
}

test('Local and AList drain an independent source read after return has already completed', { timeout: 90000 }, async t => {
  const output = path.resolve(validationOutputRoot()); await fs.mkdir(output, { recursive: true });
  const root = await fs.mkdtemp(path.join(output, 'upload-source-drain-'));
  const bytes = Buffer.alloc(131072, 0x65), prefix = bytes.subarray(0, 65536);
  for (const backend of ['local', 'alist']) for (const stop of ['caller', 'adapter', 'registry']) {
    for (const rejected of [false, true]) await t.test(`${backend}/${stop}/${rejected ? 'late-rejection' : 'late-read'}`, async t => {
      const work = path.join(root, `${backend}-${stop}-${rejected}`); await fs.mkdir(work);
      const sourcePath = path.join(work, 'source.bin'); await fs.writeFile(sourcePath, bytes);
      const file = await fs.open(sourcePath, 'r'), entered = Promise.withResolvers(), release = Promise.withResolvers();
      const returned = Promise.withResolvers(), arrived = Promise.withResolvers(), disconnected = Promise.withResolvers();
      let sourceNextFile, calls = 0, returns = 0, readCompleted = false, received = Buffer.alloc(0), service, registry, writing, closing;
      t.after(async () => {
        release.resolve(); await Promise.allSettled([writing, closing]); await registry?.close();
        await sourceNextFile?.close(); await file.close();
        if (service) await new Promise(resolve => { service.closeAllConnections(); service.close(resolve); });
        assert.equal(path.dirname(work), root); await fs.rm(work, { recursive: true });
      });
      let adapter;
      if (backend === 'local') adapter = await LocalAdapter.open({ root: work, writable: true });
      else {
        service = http.createServer((request, response) => {
          request.once('close', disconnected.resolve);
          request.on('data', chunk => { received = Buffer.concat([received, chunk]); if (received.length >= prefix.length) arrived.resolve(); });
          request.on('end', () => response.end(JSON.stringify({ code: 200, data: null })));
          request.on('error', () => {});
        });
        service.listen(0, '127.0.0.1'); await once(service, 'listening');
        adapter = new AListAdapter({ baseUrl: `http://127.0.0.1:${service.address().port}/`, capabilities: { create: true, replace: true } });
      }
      registry = new StorageRegistry(); registry.registerType(backend, () => adapter); await registry.createInstance('target', backend, {});
      const source = {
        [Symbol.asyncIterator]() { return this; },
        async next() {
          if (++calls === 1) { const chunk = Buffer.alloc(prefix.length); await file.read(chunk, 0, chunk.length, 0); return { value: chunk, done: false }; }
          assert.equal(calls, 2);
          // This read owns a separate FD. return() can finish independently;
          // only the outstanding next() knows when this resource is released.
          sourceNextFile = await fs.open(sourcePath, 'r'); entered.resolve();
          try {
            await release.promise;
            const chunk = Buffer.alloc(prefix.length);
            const { bytesRead } = await sourceNextFile.read(chunk, 0, chunk.length, prefix.length);
            assert.equal(bytesRead, prefix.length); assert.deepEqual(chunk, prefix); readCompleted = true;
            if (rejected) throw false;
            return { value: chunk, done: false };
          } finally { await sourceNextFile.close(); }
        },
        async return() { returns++; await file.close(); returned.resolve(); return { done: true }; },
      };
      const controller = new AbortController();
      writing = outcome(adapter.write('/target.bin', source, { size: BigInt(bytes.length), signal: controller.signal }));
      await entered.promise; if (backend === 'alist') await arrived.promise;
      if (stop === 'caller') controller.abort(new Error('The source owner cancelled.'));
      closing = stop === 'registry' ? registry.close() : adapter.close();
      await returned.promise; await pending(writing); await pending(closing);
      assert.equal(file.fd, -1); assert.notEqual(sourceNextFile.fd, -1); assert.equal(readCompleted, false);
      release.resolve(); await closing;
      assert.equal((await writing).error.code, 'cancelled'); assert.equal(readCompleted, true);
      assert.equal(sourceNextFile.fd, -1); assert.equal(returns, 1); assert.equal(calls, 2);
      if (backend === 'alist') await disconnected.promise;
      else received = await fs.readFile(path.join(work, 'target.bin'));
      assert.deepEqual(received, prefix);
      await assert.rejects(adapter.write('/late.bin', Buffer.alloc(0)), { code: 'closed' });
      await fs.writeFile(path.join(root, `${backend}-${stop}-${rejected}.json`), JSON.stringify({
        backend, stop, rejected, returns, calls, readCompleted, sourceFdClosed: file.fd === -1,
        nextFdClosed: sourceNextFile.fd === -1, receivedBytes: received.length,
      }, null, 2) + '\n');
    });
  }
});
