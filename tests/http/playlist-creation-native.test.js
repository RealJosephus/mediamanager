import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { currentNativeReference } from '../../tools/compat/current-native-reference.js';
import { unusedPort, portAvailable } from '../helpers/library-exchange-state.js';
import { createWebServerFixture } from '../web/web-fixture.js';

import { nativeGuid, wireGuid } from '../../src/users/native.js';
import { createMetadataHttpFixture, metadataMovieId } from '../helpers/metadata-http-fixture.js';

export const requiredValidationServices = ['postgres', 'dotnet', 'jellyfinDll', 'nativeInstance', 'currentNativeSqlite'];

async function observations(origin, token, userId) {
  const rows = [];
  for (const [query, body] of [
    ['', { Name: 'Body only', MediaType: 'Audio' }],
    ['?name=Query%20only&mediaType=Audio', undefined],
    ['?name=Query%20wins&mediaType=Video', { Name: 'Body fallback', MediaType: 'Audio', IsPublic: false }],
    ['?name=%20&mediaType=invalid&ids=bad', { Name: 'Empty query fallback', MediaType: 'Video' }],
    ['?name=Null%20body&mediaType=Video', null],
  ]) {
    const headers = { Authorization: 'MediaBrowser Token="' + token + '"', Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(origin + '/Playlists' + query, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const { Id } = await response.json();
    const item = await fetch(origin + '/Users/' + userId + '/Items/' + Id, { headers });
    const playlist = await fetch(origin + '/Playlists/' + Id, { headers });
    assert.equal(item.status, 200); assert.equal(playlist.status, 200);
    const { Name, MediaType } = await item.json();
    const { OpenAccess, Shares, ItemIds } = await playlist.json();
    rows.push({ Name, MediaType, OpenAccess, Shares, ItemIds });
  }
  return rows;
}

test('legacy and body playlist creation match the designated server on readback', { timeout: 300000 }, async t => {
  const current = await currentNativeReference();
  const parent = await mkdtemp(path.join(tmpdir(), 'playlist-creation-'));
  const clone = path.join(parent, 'instance'), port = await unusedPort(), origin = 'http://127.0.0.1:' + port;
  let reference, candidate;
  try {
    await cp(current.sourceRoot, clone, { recursive: true });
    await mkdir(path.join(clone, 'log'), { recursive: true });
    await current.prepareClone(clone, port);
    reference = current.start({ referenceRoot: clone, outputRoot: parent, label: 'playlist', origin });
    await reference.ready();
    const native = await observations(origin, current.accessToken, current.userId);
    candidate = await createWebServerFixture({ signal: t.signal });
    const login = await fetch(candidate.origin + '/Users/AuthenticateByName', { method: 'POST',
      headers: { Authorization: 'MediaBrowser Client="Playlists", Device="Fixture", DeviceId="playlist-test", Version="1"', 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: candidate.username, Pw: candidate.password }) });
    assert.equal(login.status, 200);
    const account = await login.json();
    const actual = await observations(candidate.origin, account.AccessToken, account.User.Id);
    t.diagnostic(JSON.stringify({ native, actual }));
    assert.deepEqual(actual, native);
  } finally {
    try { await candidate?.close(); } finally {
      try {
        if (reference) {
          const stopped = await reference.stop(async () => (await fetch(origin + '/System/Shutdown', { method: 'POST',
            headers: { Authorization: 'MediaBrowser Token="' + current.accessToken + '"' } })).status, () => portAvailable(port));
          assert.ok(stopped.cleanShutdown && stopped.pidGone && stopped.portAvailable, JSON.stringify(stopped));
        }
      } finally { try { await current.finish(); } finally { await rm(parent, { recursive: true, force: true }); } }
    }
  }
});

test('effective playlist owner, shares and ordered item ids survive HTTP creation in PostgreSQL', async t => {
  const { database, request, reader } = await createMetadataHttpFixture(t);
  const owner = (await request('/Users/Me', { token: reader })).body.Id;
  const editor = (await request('/Users/New', { method: 'POST', body: { Name: 'Playlist editor' } })).body.Id;
  const movie = wireGuid(metadataMovieId), body = { Name: 'Body', Ids: [], UserId: editor, MediaType: 'Audio',
    Users: [{ UserId: editor, CanEdit: true }], IsPublic: false };
  const create = (query, options) => request('/Playlists?' + query, { method: 'POST', ...options });
  assert.equal((await create('name=Denied&userId=' + editor, { body: { ...body, UserId: owner }, token: reader })).status, 403);
  const mixed = await create('name=Mixed&userId=' + owner + '&mediaType=Video&ids=' + movie + ',invalid,' + movie,
    { body, token: reader });
  assert.equal(mixed.status, 200);
  const delegated = await create('name=%20&userId=' + owner + '&ids=invalid', { body: { ...body, Ids: [movie], Name: 'Fallback' } });
  assert.equal(delegated.status, 200);
  for (const [result, name, type, ids] of [[mixed, 'Mixed', 'Video', [movie, movie]], [delegated, 'Fallback', 'Audio', [movie]]]) {
    const id = nativeGuid(result.body.Id);
    const [row] = await database.rows('BaseItems', { where: { Id: id } });
    const links = await database.rows('LinkedChildren', { where: { ParentId: id }, orderBy: [{ column: 'SortOrder', direction: 'ASC' }] });
    assert.equal(row.Name, name); assert.equal(row.MediaType, type);
    assert.deepEqual(links.map(link => wireGuid(link.ChildId)), ids);
    const data = JSON.parse(row.Data);
    assert.equal(wireGuid(data.OwnerUserId), owner);
    assert.equal(data.OpenAccess, false);
    assert.deepEqual(data.Shares.map(share => ({ ...share, UserId: wireGuid(share.UserId) })), [{ UserId: editor, CanEdit: true }]);
    const persisted = await request('/Playlists/' + result.body.Id, { token: reader });
    assert.equal(persisted.status, 200); assert.deepEqual(persisted.body.ItemIds, ids);
  }
});
