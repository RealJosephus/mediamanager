import assert from 'node:assert/strict';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { withBackupArchive } from '../../src/system/backup-archive.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';
import { startActualWebDav } from '../storage/helpers/actual-webdav.js';

export const requiredValidationServices = ['postgres', 'webdav'];

test('restore leaves both volumes and PostgreSQL intact when a WebDAV endpoint lacks a stable volume identity', async t => {
  const service = await startActualWebDav();
  t.after(() => service.stop());
  const envName = 'MEDIAMANAGER_BACKUP_TEST_DAV', previous = process.env[envName];
  process.env[envName] = service.authorization;
  try {
    const reservations = [];
    const systemLifecycle = { admit(action) {
      reservations.push(action);
      return { cancel: () => reservations.push('cancel'), commit: () => reservations.push('commit') };
    } };
    const { runtime, database, request } = await createMetadataHttpFixture(t, { systemLifecycle });
    const backups = runtime.backups, volume = path.join(service.media, 'volume'), detached = path.join(service.media, 'detached');
    const key = 'art.bin', identity = path.join(backups.paths.metadataPath, 'remote-art');
    await mkdir(volume);
    await writeFile(path.join(volume, key), 'archived A');
    const config = (await request('/Storage/Configuration')).body;
    config.instances.push({ id: 'remote-art', type: 'webdav', config: { baseUrl: service.baseUrl, credentialRef: envName } });
    config.mounts.push({ path: '/remote-art', instanceId: 'remote-art', root: '/volume', capabilities: {} });
    config.prefixes.push({ identityRoot: identity, accessRoot: '/remote-art', purpose: 'metadata',
      style: process.platform === 'win32' ? 'windows' : 'posix', returnAccess: 'WebDAV metadata' });
    assert.equal((await request('/Storage/Configuration', { method: 'POST', body: config })).status, 200);
    const marker = path.join(backups.paths.configurationDirectoryPath, 'preferences.json');
    await writeFile(marker, '1');
    const archive = await backups.create({ Database: true, Metadata: true, Subtitles: false, Trickplay: false });
    await withBackupArchive(archive.Path, zip => {
      const member = zip.json('mediamanager.json').files.find(file => file.key === 'Data/metadata/remote-art/' + key);
      assert.equal(member.binding, null);
    });
    const selection = await readFile(backups.storageConfigurationPath);
    await database.update('BaseItems', { Id: metadataMovieId }, { Name: 'current database' });
    await writeFile(marker, '2');
    await rename(volume, detached);
    await writeFile(path.join(detached, key), 'current A');
    await mkdir(volume);
    await writeFile(path.join(volume, key), 'independent B');
    assert.equal((await request('/Backup/Restore', { method: 'POST', body: { ArchiveFileName: archive.Path } })).status, 422);
    assert.deepEqual(reservations, ['restart', 'cancel']);
    await assert.rejects(stat(backups.pending), { code: 'ENOENT' });
    assert.equal((await database.rows('BaseItems', { where: { Id: metadataMovieId } }))[0].Name, 'current database');
    assert.deepEqual(await readFile(backups.storageConfigurationPath), selection);
    assert.equal(await readFile(marker, 'utf8'), '2');
    assert.equal(await readFile(path.join(detached, key), 'utf8'), 'current A');
    assert.equal(await readFile(path.join(volume, key), 'utf8'), 'independent B');
  } finally {
    if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous;
  }
});
