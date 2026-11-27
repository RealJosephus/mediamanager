import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { idKey } from '../../src/library/records.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('an AList download declines a partial response from a different object version', async t => {
  const { runtime, request, reader, database } = await createMetadataHttpFixture(t);
  let origin, body = 'abcdef', version = '"v1"', ignoreCondition = false;
  const requests = [];
  const upstream = createServer((req, res) => {
    if (req.url === '/api/fs/get') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ code: 200, data: { name: 'clip.mkv', size: body.length, is_dir: false, raw_url: origin + '/raw' } }));
      return;
    }
    requests.push([req.headers.range, req.headers['if-range']]);
    res.setHeader('ETag', version);
    if (req.headers.range === 'bytes=3-' && (ignoreCondition || req.headers['if-range'] === version)) {
      res.writeHead(206, { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' });
      res.end(body.slice(3));
    } else {
      res.setHeader('Content-Length', body.length);
      res.end(body);
    }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  origin = 'http://127.0.0.1:' + upstream.address().port;
  const config = (await request('/Storage/Configuration')).body;
  config.instances.push({ id: 'conditional', type: 'alist', config: { baseUrl: origin } });
  config.mounts.push({ path: '/objects', instanceId: 'conditional', capabilities: {} });
  config.prefixes.push({ identityRoot: '/alist-media', accessRoot: '/objects', purpose: 'library', style: 'posix',
    returnAccess: 'Versioned test volume' });
  const configured = await request('/Storage/Configuration', { method: 'POST', body: config });
  assert.ok(configured.status >= 200 && configured.status < 300, configured.bytes.toString());
  await database.update('BaseItems', { Id: metadataMovieId }, { Path: '/alist-media/clip.mkv' });
  const port = runtime.networkHost.listeners.find(item => item.scheme === 'http').port;
  const url = 'http://127.0.0.1:' + port + '/Items/' + idKey(metadataMovieId) + '/Download';
  const download = async headers => {
    const response = await fetch(url, { headers: { ...headers, Authorization: 'MediaBrowser Token="' + reader + '"' }, signal: t.signal });
    return [response.status, await response.text()];
  };
  const headers = { Range: 'bytes=3-', 'If-Range': '"v1"' };
  assert.deepEqual(await download({}), [200, 'abcdef']);
  assert.deepEqual(await download(headers), [206, 'def']);
  version = '"v2"'; body = 'UVWXYZ';
  assert.deepEqual(await download(headers), [200, 'UVWXYZ']);
  ignoreCondition = true;
  const [status, bytes] = await download(headers);
  assert.deepEqual(requests.at(-1), ['bytes=3-', '"v1"']);
  assert.equal(status, 412);
  assert.notEqual(bytes, 'XYZ');
});
