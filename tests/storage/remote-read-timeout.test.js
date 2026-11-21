import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { json } from 'node:stream/consumers';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { WebDavAdapter } from '../../plugins/webdav/adapter.js';

const content = Buffer.from('0123456789abcdef');

for (const [name, Adapter] of [['WebDAV', WebDavAdapter], ['AList', AListAdapter]]) {
  test(`${name} downloads time out on inactivity or an absolute deadline`, { timeout: 15000 }, async t => {
    const server = http.createServer(async (request, response) => {
      if (request.method === 'PROPFIND') {
        response.writeHead(207, { 'Content-Type': 'application/xml' });
        response.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>${request.url}</d:href><d:propstat><d:prop>`
          + `<d:resourcetype/><d:getcontentlength>${content.length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status>`
          + '</d:propstat></d:response></d:multistatus>');
        return;
      }
      if (request.url === '/api/fs/get') {
        const { path } = await json(request);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ code: 200, data: { name: path.slice(1), is_dir: false, size: content.length, raw_url: path } }));
        return;
      }
      response.writeHead(200, { 'Content-Length': content.length });
      response.write(content.subarray(0, 1));
      if (request.url === '/stalled') return;
      let offset = 1;
      const pulse = setInterval(() => {
        response.write(content.subarray(offset, ++offset));
        if (offset === content.length) response.end();
      }, 85);
      response.once('close', () => clearInterval(pulse));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const adapter = new Adapter({ baseUrl: `http://127.0.0.1:${server.address().port}/`, timeoutMs: 600 });
    t.after(() => adapter.close());

    await t.test('continuous bytes outlast the inactivity budget', async () => {
      const handle = await adapter.openRead('/active');
      const parts = [];
      for await (const bytes of handle.stream) parts.push(bytes);
      assert.deepEqual(Buffer.concat(parts), content);
      await handle.close();
    });

    await t.test('a stalled body still times out', async () => {
      const handle = await adapter.openRead('/stalled');
      assert.deepEqual(Buffer.from((await handle.stream.next()).value), content.subarray(0, 1));
      await assert.rejects(handle.stream.next(), { code: 'timeout' });
      await handle.close();
    });

    await t.test('progress cannot extend a caller deadline', async () => {
      const handle = await adapter.openRead('/active', { deadline: Date.now() + 1000 });
      let bytesRead = 0;
      await assert.rejects(async () => {
        for await (const bytes of handle.stream) bytesRead += bytes.byteLength;
      }, { code: 'timeout' });
      assert.ok(bytesRead > 1 && bytesRead < content.length, `Read ${bytesRead} bytes before the deadline.`);
      await handle.close();
    });

    await t.test('the caller can cancel a pending read', async () => {
      const controller = new AbortController();
      const handle = await adapter.openRead('/stalled', { signal: controller.signal });
      assert.equal((await handle.stream.next()).done, false);
      const pending = assert.rejects(handle.stream.next(), { code: 'cancelled' });
      controller.abort();
      await pending;
      await handle.close();
    });
  });
}

for (const [name, Adapter, overwrite] of [
  ['AList exclusive', AListAdapter, false],
  ['WebDAV exclusive', WebDavAdapter, false],
  ['WebDAV ordinary', WebDavAdapter, true],
]) {
  test(`${name} uploads time out on inactivity or an absolute deadline`, { timeout: 15000 }, async t => {
    const staging = new Set();
    let upload;
    const server = http.createServer(async (request, response) => {
      const { method, url } = request;
      if (method === 'MKCOL') { staging.add(url); response.writeHead(201).end(); return; }
      if (method === 'DELETE') { staging.delete(url); response.writeHead(204).end(); return; }
      if (method === 'MOVE') {
        upload.moved = request.headers.overwrite;
        response.writeHead(201).end();
        return;
      }
      const attempt = upload;
      attempt.overwrite = request.headers.overwrite;
      response.once('close', () => attempt.closed.resolve(response.writableEnded));
      try {
        for await (const part of request) {
          attempt.bytes.push(part);
          attempt.arrived.resolve();
        }
      } catch { return; }
      if (Adapter === AListAdapter) response.end(JSON.stringify({ code: 200, data: null }));
      else response.writeHead(201).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    const adapter = new Adapter({ baseUrl: `http://127.0.0.1:${server.address().port}/`, timeoutMs: 600,
      capabilities: { create: true, replace: true } });
    t.after(() => adapter.close());

    for (const mode of ['active', 'stalled', 'deadline', 'cancelled']) await t.test(mode, async () => {
      upload = { bytes: [], arrived: Promise.withResolvers(), closed: Promise.withResolvers() };
      const controller = new AbortController();
      const paused = Promise.withResolvers();
      let offset = 0, returned = 0;
      const source = { [Symbol.asyncIterator]: () => ({
        async next() {
          if (offset === content.length) return { done: true };
          if (offset && ['stalled', 'cancelled'].includes(mode)) return paused.promise;
          if (offset) await delay(85);
          return { value: content.subarray(offset, ++offset), done: false };
        },
        return() { returned++; paused.resolve({ done: true }); return { done: true }; },
      }) };
      const writing = adapter.write('/recording.ts', source, { size: content.length, overwrite, signal: controller.signal,
        deadline: mode === 'deadline' ? Date.now() + 1000 : undefined });
      if (mode === 'active') {
        assert.equal((await writing).size, BigInt(content.length));
        assert.equal(await upload.closed.promise, true);
        assert.deepEqual(Buffer.concat(upload.bytes), content);
        if (Adapter === WebDavAdapter && !overwrite) assert.equal(upload.moved, 'F');
      } else {
        const rejected = assert.rejects(writing, { code: mode === 'cancelled' ? 'cancelled' : 'timeout' });
        if (mode === 'cancelled') {
          await upload.arrived.promise;
          controller.abort();
        }
        await rejected;
        assert.equal(await upload.closed.promise, false);
        const received = Buffer.concat(upload.bytes);
        assert.ok(received.length >= (mode === 'deadline' ? 2 : 1) && received.length < content.length);
        assert.deepEqual(received, content.subarray(0, received.length));
        assert.equal(upload.moved, undefined);
      }
      assert.equal(returned, 1);
      if (Adapter === AListAdapter) assert.equal(upload.overwrite, 'false');
      assert.equal(staging.size, 0);
    });
  });
}
