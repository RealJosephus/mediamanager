import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { unusedPort, portAvailable } from '../helpers/library-exchange-state.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite'];

test('appending a mixed delimited list to an existing playlist uses the designated binder', { timeout: 240000 }, async t => {
  const current = await currentNativeReference();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mm-playlist-append-')), clone = path.join(root, 'instance');
  const port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  let reference;
  try {
    await cp(current.sourceRoot, clone, { recursive: true });
    await mkdir(path.join(clone, 'log'), { recursive: true });
    await current.prepareClone(clone, port);
    reference = current.start({ referenceRoot: clone, outputRoot: root, label: 'playlist-append', origin });
    await reference.ready();
    const headers = { Authorization: 'MediaBrowser Token="' + current.accessToken + '"', 'Content-Type': 'application/json' };
    const created = await fetch(origin + '/Playlists', { method: 'POST', headers, body: JSON.stringify({ Name: 'Audit append', MediaType: 'Video' }) });
    assert.equal(created.status, 200);
    const nativeId = (await created.json()).Id;
    const valid = wireGuid(metadataMovieId);
    const suffix = '/Items?ids=' + valid + ',outdated,' + valid;
    const native = await fetch(origin + '/Playlists/' + nativeId + suffix, { method: 'POST', headers });
    await native.arrayBuffer();
    const { database, request, reader } = await createMetadataHttpFixture(t);
    const playlist = await request('/Playlists', { method: 'POST', body: { Name: 'Audit append', MediaType: 'Video' }, token: reader });
    assert.equal(playlist.status, 200);
    const route = '/Playlists/' + playlist.body.Id;
    const items = async () => (await database.rows('LinkedChildren', {
      where: { ParentId: nativeGuid(playlist.body.Id) }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }],
    })).map(row => wireGuid(row.ChildId));
    const candidate = await request(route + suffix, { method: 'POST', token: reader });
    const afterMixed = await items();
    const control = await request(route + '/Items?ids=' + valid + ',' + valid, { method: 'POST', token: reader });
    const afterControl = await items();
    const observed = { nativeStatus: native.status, candidateStatus: candidate.status, candidateErrors: candidate.body?.errors,
      afterMixed, controlStatus: control.status, afterControl, valid };
    t.diagnostic('AUDIT playlist-append ' + JSON.stringify(observed));
    assert.equal(native.status, 204);
    assert.equal(control.status, 204);
    assert.deepEqual(afterControl.slice(-2), [valid, valid]);
    assert.equal(candidate.status, native.status);
    assert.deepEqual(afterMixed, [valid, valid]);
  } finally {
    try {
      if (reference) {
        const stop = await reference.stop(async () => (await fetch(origin + '/System/Shutdown', {
          method: 'POST', headers: { Authorization: 'MediaBrowser Token="' + current.accessToken + '"' },
        })).status, () => portAvailable(port));
        assert.ok(stop.cleanShutdown && stop.pidGone && stop.portAvailable);
      }
    } finally { try { await current.finish(); } finally { await rm(root, { recursive: true, force: true }); } }
  }
});
