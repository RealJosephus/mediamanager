import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { json } from 'node:stream/consumers';
import test from 'node:test';
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
