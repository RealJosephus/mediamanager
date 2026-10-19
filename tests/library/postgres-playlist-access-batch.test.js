import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queryPostgresPlaylistAccessBatch } from '../../src/library/postgres-playlist-query.js';

const ids = [
  'a1000000-0000-0000-0000-000000000001',
  'a1000000-0000-0000-0000-000000000002',
  'a1000000-0000-0000-0000-000000000003',
  'a1000000-0000-0000-0000-000000000004',
];
const key = value => value.replaceAll('-', '').toLowerCase();
const playlist = (Id, values = {}) => ({
  NativeType: 'MediaBrowser.Controller.Playlists.Playlist',
  Type: 'Playlist',
  Id,
  Path: null,
  ...values,
});
const visibility = {
  allTopParentIds: [],
  allowedTopParentIds: [],
  collectionBlockedTopParentIds: [],
  collectionAllowedTopParentIds: [],
  blockedTags: [],
  allowedTags: [],
  maxRating: 5,
  maxSubRating: null,
  blockUnratedTypes: [],
};

test('PostgreSQL evaluates a page of playlist member gates in one partitioned query', async () => {
  const calls = [];
  const database = {
    dialect: 'postgres',
    schemaName: 'playlist_batch_fixture',
    client: { async query(plan) {
      calls.push(plan);
      return { rows: [
        { PlaylistKey: key(ids[0]), HasAllowedChild: true, HasResolvedChild: true },
        { PlaylistKey: key(ids[1]), HasAllowedChild: false, HasResolvedChild: true },
        { PlaylistKey: key(ids[2]), HasAllowedChild: false, HasResolvedChild: false },
      ] };
    } },
  };
  const user = { Id: 'b1000000-0000-0000-0000-000000000001' };
  const dataPath = path.join(tmpdir(), 'playlist-access-batch', 'data');
  const result = await queryPostgresPlaylistAccessBatch(database, [
    playlist(ids[0]),
    playlist(ids[1]),
    playlist(ids[2]),
    playlist(ids[3], {
      Path: path.join(dataPath, 'playlists', 'private'),
      OpenAccess: false,
      OwnerUserId: 'b1000000-0000-0000-0000-000000000002',
      Shares: [],
    }),
  ], { user, dataPath, visibility });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values[0], ids.slice(0, 3).map(key));
  assert.match(calls[0].text, /WITH RECURSIVE requested/u);
  assert.match(calls[0].text,
    /rating_ancestor\."__PlaylistKey" = selected\."__PlaylistKey"/u);
  assert.deepEqual([...result], [
    [key(ids[3]), false],
    [key(ids[0]), true],
    [key(ids[1]), false],
    [key(ids[2]), true],
  ]);
});

test('PostgreSQL playlist access batch avoids SQL when no member gate is required', async () => {
  let queried = false;
  const database = {
    dialect: 'postgres',
    schemaName: 'playlist_batch_fixture',
    client: { async query() { queried = true; return { rows: [] }; } },
  };
  const result = await queryPostgresPlaylistAccessBatch(database,
    [playlist(ids[0]), playlist(ids[1])], { visibility });

  assert.equal(queried, false);
  assert.deepEqual([...result.values()], [true, true]);
});
