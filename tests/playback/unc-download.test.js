import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { createPostgresTestDatabase, dropPostgresTestDatabase, postgresTestConnectionString, postgresTestRow } from '../database/postgres-fixture.js';
import { createTestRuntime } from '../helpers/runtime.js';

export const requiredValidationServices = ['postgres'];

test('UNC downloads resolve either separator on the same mount and suggest only the basename', {
  skip: !postgresTestConnectionString,
}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'unc-download-'));
  let database, runtime;
  t.after(async () => {
    try { await runtime?.close(); }
    finally { try { await dropPostgresTestDatabase(database); } finally { await rm(root, { recursive: true, force: true }); } }
  });
  const media = path.join(root, 'media'), storageConfiguration = path.join(root, 'storage.json');
  const bytes = Buffer.from([0, 1, 128, 255]);
  await mkdir(media);
  await writeFile(path.join(media, 'clip.mkv'), bytes);
  await writeFile(storageConfiguration, JSON.stringify({
    instances: [{ id: 'films', type: 'local', config: { root: media, writable: false } }],
    mounts: [{ instanceId: 'films', path: '/films', root: '/', capabilities: {} }],
    prefixes: [{ style: 'windows', identityRoot: '\\\\nas\\Films', accessRoot: '/films', caseSensitive: false,
      returnAccess: 'Isolated UNC download fixture.' }],
  }));
  database = await createPostgresTestDatabase(null, 'unc_download');
  runtime = await createTestRuntime({ database, storageConfiguration, programDataPath: path.join(root, 'program'),
    configurationDirectoryPath: path.join(root, 'config'), configuration: { IsStartupWizardCompleted: true }, serverId: 'unc-download' });
  const token = (await runtime.apiKeys.create('UNC download')).AccessToken;
  const port = runtime.networkHost.listeners.find(entry => entry.scheme === 'http').port;
  const id = nativeGuid('60810000000000000000000000000001');
  const identity = '\\\\nas\\Films\\clip.mkv';
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: id, Type: 'MediaBrowser.Controller.Entities.Movies.Movie',
    Name: 'Clip', MediaType: 'Video', Path: identity, SortName: 'clip', PresentationUniqueKey: idKey(id),
    DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }));
  for (const filename of [identity, '//nas/Films/clip.mkv']) {
    await database.update('BaseItems', { Id: id }, { Path: filename });
    const response = await fetch('http://127.0.0.1:' + port + '/Items/' + idKey(id) + '/Download', {
      headers: { 'X-Emby-Token': token }, signal: t.signal,
    });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, filename);
    assert.deepEqual(body, bytes);
    assert.equal(response.headers.get('content-disposition'), "attachment; filename=clip.mkv; filename*=UTF-8''clip.mkv");
  }
});
