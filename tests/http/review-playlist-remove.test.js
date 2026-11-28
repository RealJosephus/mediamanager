import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { unusedPort, portAvailable } from '../helpers/library-exchange-state.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite'];

test('padded string entry ids remove the selected playlist member on the designated host and candidate', { timeout: 240000 }, async t => {
  const current = await currentNativeReference();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-playlist-remove-'));
  const clone = path.join(root, 'instance'), media = path.join(root, 'audio');
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  let reference;
  try {
    await mkdir(media);
    const song = path.join(media, 'song.flac');
    await copyFile(new URL('../playback/fixtures/flac-copy-current/assets/upstream/subset/60%20-%20mono%20audio.flac', import.meta.url), song);
    await cp(current.sourceRoot, clone, { recursive: true });
    await mkdir(path.join(clone, 'log'), { recursive: true });
    await current.prepareClone(clone, port);
    reference = current.start({ referenceRoot: clone, outputRoot: root, label: 'playlist-remove', origin });
    await reference.ready();
    const native = (route, method='GET', body) => fetch(origin + route, { method,
      headers: { Authorization: 'MediaBrowser Token="' + current.accessToken + '"', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const options = { Enabled: true, EnableInternetProviders: false, EnableRealtimeMonitor: false,
      SaveLocalMetadata: false, MetadataSavers: [], EnableLUFSScan: false, PathInfos: [{ Path: media }],
      TypeOptions: ['Audio', 'MusicAlbum', 'MusicArtist'].map(Type => ({ Type, MetadataFetchers: [], ImageFetchers: [] })) };
    assert.equal((await native('/Library/VirtualFolders?name=Audit&collectionType=music&refreshLibrary=false', 'POST', { LibraryOptions: options })).status, 204);
    const scan = (await (await native('/ScheduledTasks')).json()).find(task => task.Key === 'RefreshLibrary');
    assert.equal((await native('/ScheduledTasks/Running/' + scan.Id, 'POST')).status, 204);
    const deadline = Date.now() + 120000;
    for (;;) {
      const state = await (await native('/ScheduledTasks/' + scan.Id)).json();
      if (state.State === 'Idle' && state.LastExecutionResult?.StartTimeUtc !== scan.LastExecutionResult?.StartTimeUtc) {
        assert.equal(state.LastExecutionResult.Status, 'Completed');
        break;
      }
      assert.ok(Date.now() < deadline, 'the controlled native library scan must finish');
      await delay(100);
    }
    const audio = (await (await native('/Items?Recursive=true&IncludeItemTypes=Audio&Fields=Path')).json()).Items.find(item => item.Path === song);
    assert.ok(audio);
    const create = await native('/Playlists','POST',{ Name: 'Audit removal', MediaType: 'Audio', Ids: [audio.Id] });
    assert.equal(create.status, 200);
    const rid = (await create.json()).Id;
    const nitems = async () => (await (await native('/Playlists/' + rid)).json()).ItemIds;
    const nb = await nitems();
    assert.equal(nb.length, 1);
    const nd = await native('/Playlists/' + rid + '/Items?entryIds=' + encodeURIComponent(' ' + nb[0] + ' '), 'DELETE');
    await nd.arrayBuffer();
    const na = await nitems();
    const { database, request, reader } = await createMetadataHttpFixture(t);
    const added = await request('/Playlists', { method: 'POST', token: reader, body: { Name: 'Audit removal', MediaType: 'Video', Ids: [wireGuid(metadataMovieId)] } });
    assert.equal(added.status, 200);
    const id = added.body.Id, route = '/Playlists/' + id + '/Items?entryIds=';
    const rows = async () => (await database.rows('LinkedChildren', { where: { ParentId: nativeGuid(id) } })).map(row => wireGuid(row.ChildId));
    const before = await rows();
    assert.equal(before.length, 1);
    const cd = await request(route + encodeURIComponent(' ' + before[0] + ' '), { method: 'DELETE', token: reader });
    const after = await rows();
    const control = await request(route + before[0], { method: 'DELETE', token: reader });
    const afterControl = await rows();
    const observed = { nativeStatus: nd.status, nativeBefore: nb.length, nativeAfter: na.length, candidateStatus: cd.status,
      candidateBefore: before.length, candidateAfter: after.length, controlStatus: control.status, controlAfter: afterControl.length };
    t.diagnostic('AUDIT playlist-remove ' + JSON.stringify(observed));
    assert.equal(nd.status, 204);
    assert.equal(na.length, 0);
    assert.equal(control.status, 204);
    assert.equal(afterControl.length, 0);
    assert.equal(cd.status, 204);
    assert.equal(after.length, 0);
  } finally {
    try {
      if (reference) {
        const stopped = await reference.stop(async () => (await fetch(origin + '/System/Shutdown', { method: 'POST',
          headers: { Authorization: 'MediaBrowser Token="' + current.accessToken + '"' } })).status, () => portAvailable(port));
        assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable);
      }
    } finally { try { await current.finish(); } finally { await rm(root, { recursive: true, force: true }); } }
  }
});
