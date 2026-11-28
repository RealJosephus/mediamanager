import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeStreamRow } from '../../src/library/probe-service.js';
import { idKey, MIN_DATE } from '../../src/library/records.js';
import { nativeGuid } from '../../src/users/native.js';
import { postgresTestRow } from '../database/postgres-fixture.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres'];

for (const type of ['Subtitle', 'Lyric']) {
  test(type + ' deletion keeps its original mount through reconfiguration', { timeout: 60000 }, async t => {
    const { database, filename, programDataPath, request, runtime } = await createMetadataHttpFixture(t);
    const originalRoot = path.dirname(filename), replacementRoot = path.join(programDataPath, 'replacement-volume');
    await mkdir(replacementRoot);
    let itemId = metadataMovieId, media = filename, sidecar = 'Initial.en.srt', route = '/Videos/' + idKey(itemId) + '/Subtitles/3';
    if (type === 'Lyric') {
      itemId = nativeGuid('60810000000000000000000000000055');
      route = '/Audio/' + idKey(itemId) + '/Lyrics';
      media = path.join(originalRoot, 'song.flac');
      sidecar = 'song.lrc';
      await copyFile(new URL('../playback/fixtures/flac-copy-current/assets/upstream/subset/60%20-%20mono%20audio.flac', import.meta.url), media);
      await database.insert('BaseItems', postgresTestRow('BaseItems', { Id: itemId, Type: 'MediaBrowser.Controller.Entities.Audio.Audio',
        Name: 'Song', CleanName: 'Song', SortName: 'Song', MediaType: 'Audio', Path: media, PresentationUniqueKey: idKey(itemId),
        Data: '{}', DateCreated: MIN_DATE, DateModified: MIN_DATE, DateLastSaved: MIN_DATE, DateLastRefreshed: MIN_DATE }));
    }
    await copyFile(media, path.join(replacementRoot, path.basename(media)));
    const originalFile = path.join(originalRoot, sidecar), replacementFile = path.join(replacementRoot, sidecar);
    await writeFile(originalFile, 'original content');
    await writeFile(replacementFile, 'independent content');
    await database.insert('MediaStreamInfos', probeStreamRow(itemId, { Type: type, Index: 3,
      Codec: path.extname(sidecar).slice(1), Language: 'eng', IsExternal: true, Path: originalFile,
      IsTextSubtitleStream: type === 'Subtitle', SupportsExternalStream: type === 'Subtitle' }));

    const { body: configuration } = await request('/Storage/Configuration');
    configuration.instances.find(instance => instance.id === 'fixture-media').config.root = replacementRoot;
    const files = runtime.storage.mediaFileSystem, owner = files.vfs, access = files.accessPath(originalFile);
    const originalStat = owner.stat.bind(owner), checked = Promise.withResolvers(), resume = Promise.withResolvers();
    t.signal.addEventListener('abort', () => resume.resolve(), { once: true });
    t.mock.method(owner, 'stat', async (location, options) => {
      const result = await originalStat(location, options);
      if (location === access) {
        checked.resolve();
        await resume.promise;
      }
      return result;
    });
    const deletion = request(route, { method: 'DELETE' });
    try {
      await Promise.race([checked.promise, deletion.then(result => assert.fail('Deletion finished before stat: ' + result.status))]);
      const switched = await request('/Storage/Configuration', { method: 'POST', body: configuration });
      assert.equal(switched.status, 200, switched.bytes.toString());
    } finally { resume.resolve(); }
    const result = await deletion;
    assert.equal(result.status, 204, result.bytes.toString());
    assert.equal(await readFile(replacementFile, 'utf8'), 'independent content');
    await assert.rejects(readFile(originalFile), { code: 'ENOENT' });
  });
}
