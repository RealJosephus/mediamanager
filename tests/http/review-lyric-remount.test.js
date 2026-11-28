import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { createMetadataHttpFixture } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

test('a lyric deletion keeps the Local volume that supplied the file stat', async t => {
  const { database, filename, programDataPath, request, runtime } = await createMetadataHttpFixture(t);
  const a = path.dirname(filename), b = path.join(programDataPath, 'replacement-volume');
  await mkdir(b);
  const audio = nativeGuid('60810000000000000000000000000055'), song = path.join(a, 'song.flac');
  await copyFile(new URL('../playback/fixtures/flac-copy-current/assets/upstream/subset/60%20-%20mono%20audio.flac', import.meta.url), song);
  await copyFile(song, path.join(b, 'song.flac'));
  await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: audio, Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
    Name: 'Original sound', CleanName: 'Original sound', SortName: 'Original sound', MediaType: 'Audio', Path: song,
    PresentationUniqueKey: idKey(audio), Data: '{}', DateCreated: MIN_DATE, DateModified: MIN_DATE,
    DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }));
  const basename = 'song.lrc', first = path.join(a, basename), second = path.join(b, basename);
  await writeFile(first, 'A original');
  await writeFile(second, 'B independent');
  await database.insert('MediaStreamInfos', probeStreamRow(audio, {
    Type: 'Lyric', Index: 3, Codec: 'lrc', Language: 'eng',
    IsExternal: true, Path: first,
  }));

  const before = await request('/Storage/Configuration');
  assert.equal(before.status, 200);
  before.body.instances.find(instance => instance.id === 'fixture-media').config.root = b;
  const ownerVfs = runtime.storage.mediaFileSystem.vfs;
  const selected = runtime.storage.mediaFileSystem.accessPath(first);
  const originalStat = ownerVfs.stat.bind(ownerVfs);
  const entered = Promise.withResolvers(), proceed = Promise.withResolvers();
  let suspended = false;
  t.mock.method(ownerVfs, 'stat', async (location, options) => {
    const result = await originalStat(location, options);
    if (!suspended && location === selected) {
      suspended = true;
      assert.equal(result.kind, 'file');
      entered.resolve();
      await proceed.promise;
    }
    return result;
  });
  const deletion = request('/Audio/' + idKey(audio) + '/Lyrics', { method: 'DELETE' });
  let switched;
  try {
    await Promise.race([entered.promise, deletion.then(response => {
      throw new Error('Deletion completed before the file stat: ' + response.status);
    })]);
    switched = await request('/Storage/Configuration', { method: 'POST', body: before.body });
    assert.ok(switched.status >= 200 && switched.status < 300, switched.bytes.toString());
  } finally { proceed.resolve(); }
  const result = await deletion;
  async function content(name) {
    try { return await readFile(name, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const observed = { deleteStatus: result.status, remountStatus: switched.status, volumeA: await content(first), volumeB: await content(second) };
  t.diagnostic('AUDIT lyric-deletion ' + JSON.stringify(observed));
  assert.equal(observed.volumeB, 'B independent', 'A pending deletion must preserve the independently mounted lyric');
});
