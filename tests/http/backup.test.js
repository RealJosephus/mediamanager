import assert from 'node:assert/strict';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { readZipDirectory } from '../../src/storage/zip-directory.js';
import { BackupRestored, SystemBackups } from '../../src/system/backups.js';
import { backupFormat, writeBackupArchive } from '../../src/system/backup-archive.js';
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

test('restore checks server and engine versions before restart admission and again before cold writes', async t => {
  const { runtime, request } = await createMetadataHttpFixture(t);
  const active = runtime.backups;
  const server = serverVersion => new SystemBackups({ paths: active.paths, store: active.store, storage: active.storage,
    serverId: active.serverId, serverVersion });
  const producer = server('13.10.0'), older = server('13.9.0');
  const options = { Database: false, Metadata: false, Subtitles: false, Trickplay: false };
  const config = path.join(active.paths.configurationDirectoryPath, 'version-marker.xml');
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, '<marker>archived</marker>');
  const archive = await producer.create(options);
  await writeFile(config, '<marker>current</marker>');
  const rejectAdmission = { admit() { assert.fail('An incompatible restore reserved a restart'); } };
  const pending = path.join(active.pending, 'request.json');
  assert.equal((await request('/Backup/Restore', { method: 'POST', body: { ArchiveFileName: archive.Path } })).status, 422);
  await assert.rejects(older.stageRestore(archive.Path, rejectAdmission), { status: 422 });
  await assert.rejects(stat(pending), { code: 'ENOENT' });
  for (const [field, value] of [['BackupEngineVersion', '2.0.0'], ['ServerVersion', 'invalid']]) {
    const file = path.join(active.directory, field + '.zip');
    await writeBackupArchive(file, active.directory, { ...archive, [field]: value },
      { format: backupFormat, serverId: active.serverId, metadataPath: active.paths.metadataPath }, async () => {});
    await assert.rejects(producer.stageRestore(file, rejectAdmission), { status: 422 });
  }

  await producer.stageRestore(archive.Path, { admit: () => ({ cancel() {} }) });
  await assert.rejects(older.restorePending(), { status: 422 });
  assert.equal(await readFile(config, 'utf8'), '<marker>current</marker>');
  const staged = await readFile(pending, 'utf8'), incompatible = JSON.parse(staged);
  incompatible.manifest.BackupEngineVersion = '1.1.0';
  await writeFile(pending, JSON.stringify(incompatible));
  await assert.rejects(producer.restorePending(), { status: 422 });
  assert.equal(await readFile(config, 'utf8'), '<marker>current</marker>');
  await writeFile(pending, staged);
  await assert.rejects(server('13.10.0.0').restorePending(), BackupRestored);
  assert.equal(await readFile(config, 'utf8'), '<marker>archived</marker>');
});
