import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openStorageFixture } from './configured-fixture.js';
import { DotIgnoreRule } from '../../src/library/dot-ignore-rule.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ignore-bootstrap-')), calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ method: request.method, url: request.url });
    response.writeHead(404); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`, filename = path.join(directory, 'storage.json');
  const configuration = {
    instances: ['media', 'ancestors'].map(id => ({ id, type: 'webdav', config: { baseUrl: `${origin}/${id}/` } })),
    mounts: ['media', 'ancestors'].map(id => ({ path: '/' + id, instanceId: id, capabilities: {} })),
    prefixes: [{ identityRoot: 'Z:\\Movies', accessRoot: '/media', style: 'windows', returnAccess: 'Controlled media namespace' }],
    bindings: [{ itemId: '31000000-0000-0000-0000-000000000001', accessPath: '/media/Film.mkv' }],
    ignorePrefixes: [{ identityRoot: 'Z:\\', accessRoot: '/ancestors', style: 'windows', returnAccess: 'Controlled ancestor ignore namespace' }]
  };
  const save = () => writeFile(filename, JSON.stringify(configuration)); await save();
  return { configuration, filename, calls, save };
}

test('configured ignore ancestors use WebDAV without extending media identity or item bindings', async t => {
  const value = await fixture(t), storage = await openStorageFixture(t, value.filename); t.after(() => storage.close());
  assert.equal(storage.identityMap.resolve({ itemId: value.configuration.bindings[0].itemId }), '/media/Film.mkv');
  assert.equal(storage.ignoreIdentityMap.resolve({ identityPath: 'Z:\\Movies\\Film.mkv', style: 'windows' }), '/media/Film.mkv');
  assert.throws(() => storage.identityMap.resolve({ identityPath: 'Z:\\Outside\\movie.mkv', style: 'windows' }), { code: 'not-found' });
  const rule = new DotIgnoreRule({ vfs: storage.vfs, identityMap: storage.ignoreIdentityMap });
  assert.deepEqual(await rule.check('Z:\\Movies\\Film.mkv'), { ignored: false, complete: true });
  assert.deepEqual(value.calls, [{ method: 'PROPFIND', url: '/media/.ignore' }, { method: 'PROPFIND', url: '/ancestors/.ignore' }]);
});

test('omitting ignore ancestor mappings preserves an explicitly incomplete search', async t => {
  const value = await fixture(t); delete value.configuration.ignorePrefixes; await value.save();
  const storage = await openStorageFixture(t, value.filename); t.after(() => storage.close());
  assert.deepEqual(storage.ignoreIdentityMap.exportState(), storage.identityMap.exportState());
  const rule = new DotIgnoreRule({ vfs: storage.vfs, identityMap: storage.ignoreIdentityMap });
  await assert.rejects(rule.shouldIgnore('Z:\\Movies\\Film.mkv'), { code: 'ignore-search-unmapped', status: 501 });
  assert.deepEqual(value.calls, [{ method: 'PROPFIND', url: '/media/.ignore' }]);
});

test('invalid ignore namespace configuration fails before any network request', async t => {
  const value = await fixture(t);
  value.configuration.ignorePrefixes = {}; await value.save();
  await assert.rejects(openStorageFixture(t, value.filename), /instances, mounts and prefixes arrays/);
  value.configuration.ignorePrefixes = [value.configuration.prefixes[0]]; await value.save();
  await assert.rejects(openStorageFixture(t, value.filename), { code: 'already-exists' });
  assert.deepEqual(value.calls, []);
});
