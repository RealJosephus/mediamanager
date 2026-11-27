import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readZipDirectory } from '../../src/storage/zip-directory.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('elevated Backup routes create, list and read genuine archives with selectable payloads', async t => {
  const { runtime, request, reader, errors } = await createMetadataHttpFixture(t);
  const routes = [['GET', '/Backup'], ['GET', '/Backup/Manifest'], ['POST', '/Backup/Create'], ['POST', '/Backup/Restore']];
  for (const [method, route] of routes) {
    assert.ok(runtime.implementedRoutes.includes(method + ' ' + route));
    for (const [token, status] of [[null, 401], [reader, 403]]) assert.equal((await request(route, { method, token })).status, status);
  }
  assert.deepEqual((await request('/Backup')).body, []);
  assert.equal((await request('/Backup/Manifest')).status, 400);
  assert.equal((await request('/Backup/Manifest?path=missing.zip')).status, 404);
  assert.equal((await request('/Backup/Restore', { method: 'POST', body: { ArchiveFileName: 'missing.zip' } })).status, 404);
  assert.equal((await request('/Backup/Create', { method: 'POST', body: { Database: 'false' } })).status, 400);
  for (const include of [false, true]) {
    const options = { Database: include, Metadata: false, Trickplay: false, Subtitles: false };
    const created = await request('/Backup/Create', { method: 'POST', body: include ? {} : { database: false } });
    assert.equal(created.status, 200, errors.map(error => error.stack).join('\n'));
    assert.deepEqual(created.body.Options, options);
    const { Path: archive } = created.body;
    assert.equal(path.dirname(archive), path.join(runtime.applicationPaths.dataPath, 'backups'));
    const manifest = await request('/Backup/Manifest?path=' + encodeURIComponent(archive));
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.body, created.body);
    const file = await open(archive);
    try {
      const { entries } = readZipDirectory(file.fd, (await file.stat()).size);
      assert.ok(entries.some(entry => entry.key === 'manifest.json'));
      assert.ok(entries.some(entry => entry.key === 'Database/catalog.json') === include);
      assert.ok(entries.every(entry => !entry.key.startsWith('Data/metadata/')));
      t.diagnostic(JSON.stringify({ database: include, entries: entries.length, bytes: (await file.stat()).size }));
    } finally { await file.close(); }
    assert.deepEqual((await request('/Backup')).body[0], created.body);
  }
  await writeFile(path.join(runtime.applicationPaths.dataPath, 'backups', 'invalid.zip'), 'not a ZIP archive');
  assert.equal((await request('/Backup/Manifest?path=invalid.zip')).status, 204);
  assert.equal((await request('/Backup')).body.length, 2);
});
