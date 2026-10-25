import { testFileSystem } from '../storage/plugin-files.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StorageRegistry, VirtualFileSystem } from '../../src/storage/index.js';
import { AListAdapter } from '../../plugins/alist/adapter.js';
import { createNfoPlugin } from '../../plugins/nfo/plugin.js';

async function bytes(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('NFO writes and rereads through the production VFS and AList adapter using an isolated HTTP fixture', async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'nfo-alist-state-'));
  const spoolRoot = path.join(stateRoot, 'metadata-spool');
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  await mkdir(spoolRoot);
  const objects = new Map();
  const writes = [];
  let denied = false;
  let baseUrl;
  const server = http.createServer(async (request, response) => {
    const reply = (data, code = 200) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ code, message: code === 200 ? 'success' : 'fixture failure', data }));
    };
    try {
      if (request.url === '/api/fs/get') {
        const { path } = JSON.parse(await bytes(request));
        const data = objects.get(path);
        if (!data) { reply(null, 404); return; }
        reply({ name: path.split('/').at(-1), size: data.length, is_dir: false,
          modified: '2026-09-26T03:04:05Z', raw_url: `${baseUrl}/download?path=${encodeURIComponent(path)}` });
      } else if (request.url === '/api/fs/put') {
        const data = await bytes(request);
        if (denied) { reply(null, 403); return; }
        const path = decodeURIComponent(request.headers['file-path']);
        assert.equal(request.method, 'PUT');
        assert.equal(request.headers['as-task'], 'false');
        assert.equal(Number(request.headers['content-length']), data.length);
        objects.set(path, data);
        writes.push(path);
        reply(null);
      } else if (request.url.startsWith('/download?')) {
        assert.equal(request.headers.authorization, undefined);
        const path = new URL(request.url, baseUrl).searchParams.get('path');
        const data = objects.get(path);
        if (!data) { response.writeHead(404); response.end(); return; }
        response.setHeader('Content-Length', String(data.length));
        response.end(data);
      } else { response.writeHead(404); response.end(); }
    } catch { response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registry = new StorageRegistry();
  registry.registerType('alist', (config) => new AListAdapter(config, { resolveCredential: async () => 'fixture-only-token' }));
  await registry.createInstance('write', 'alist', { baseUrl, credentialRef: 'isolated', capabilities: { create: true, replace: true } });
  await registry.createInstance('read', 'alist', { baseUrl, credentialRef: 'isolated' });
  const vfs = new VirtualFileSystem(registry);
  vfs.mount({ path: '/network', instanceId: 'write', capabilities: { create: true, replace: true } });
  vfs.mount({ path: '/readonly', instanceId: 'read', capabilities: {} });
  t.after(async () => {
    await registry.close();
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  });
  const plugin = createNfoPlugin({fileSystem: testFileSystem,  vfs, spoolRoot });
  const item = { Type: 'Video', Path: 'D:\\identity\\sample.mkv', Name: '中文 %2F sample', DateCreated: '2026-01-01T00:00:00Z' };
  const originalPath = item.Path;
  assert.deepEqual(await readdir(spoolRoot), []);
  const first = await plugin.save(item, { accessPath: '/network/sample.mkv' });
  assert.deepEqual(first, { path: '/network/sample.nfo', changed: true });
  assert.deepEqual(writes, ['/sample.nfo']);
  assert.equal(item.Path, originalPath);
  assert.deepEqual(await readdir(spoolRoot), []);
  assert.match(objects.get('/sample.nfo').toString(), /中文 %2F sample/u);
  const metadata = await plugin.getMetadata(item, { accessPath: '/network/sample.mkv' });
  assert.equal(metadata.HasMetadata, true);
  assert.equal(metadata.Item.Name, item.Name);
  const unchanged = await plugin.save(item, { accessPath: '/network/sample.mkv' });
  assert.equal(unchanged.changed, false);
  assert.equal(writes.length, 1);
  const originalBytes = Buffer.from(objects.get('/sample.nfo'));
  await assert.rejects(plugin.save({ ...item, Name: 'Edited' }, { accessPath: '/readonly/sample.mkv' }), { code: 'not-supported' });
  assert.deepEqual(await readdir(spoolRoot), []);
  denied = true;
  await assert.rejects(plugin.save({ ...item, Name: 'Edited' }, { accessPath: '/network/sample.mkv' }), { code: 'permission-denied' });
  assert.deepEqual(await readdir(spoolRoot), []);
  assert.deepEqual(objects.get('/sample.nfo'), originalBytes);
  assert.equal(writes.length, 1);
});
