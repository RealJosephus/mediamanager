import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createPlaylistItemResolver } from '../../src/library/collection-playlist-item-resolver.js';
import {
  audioNativeType,
  createAudioItemResolver,
  musicAlbumNativeType,
  musicArtistNativeType
} from '../../src/library/audio-item-resolver.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const root = {
  Id: '10000000-0000-0000-0000-000000000001',
  Path: 'Z:\\Music',
  Type: 'MediaBrowser.Controller.Entities.Folder',
  NativeType: 'MediaBrowser.Controller.Entities.Folder',
  IsFolder: true
};
const collectionContext = Object.freeze({
  collectionType: 'music',
  collectionTypeSource: 'collection-folder',
  collections: Object.freeze([{ collectionType: 'music' }]),
  contentTypeOverrides: Object.freeze([])
});
const safeAudioExtensions = Object.freeze([
  '.669', '.3gp', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf', '.aif',
  '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.dmf', '.dsf', '.dsm',
  '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym', '.hps', '.imf',
  '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg', '.mp2', '.mp3',
  '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.nsv', '.oga', '.ogg', '.okt', '.opus', '.ra',
  '.rf64', '.rm', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.ult', '.uni', '.vox', '.wav', '.wma', '.wv',
  '.xm', '.xsp', '.ymf'
]);
const withheldAudioExtensions = Object.freeze([
  '.pls', '.m3u', '.m3u8', '.wpl', '.zpl'
]);

function candidate(identityPath, kind = 'directory') {
  const name = identityPath.split('\\').at(-1);
  return {
    identityPath,
    accessPath: identityPath.replace('Z:\\Music', '/music').replaceAll('\\', '/'),
    entry: { kind, name, size: kind === 'file' ? 7 : undefined }
  };
}

function snapshot(children, deletionSafe = true) {
  return { candidates: children, listing: { deletionSafe, entries: children.map(child => child.entry) } };
}

function pipeline() {
  return new DirectoryItemResolverPipeline({ resolvers: [createAudioItemResolver()], programDataPath });
}

function peek(snapshots) {
  return async directory => snapshots.get(directory.identityPath) ?? snapshot([], false);
}

test('strong Album and Artist/Album hierarchies produce deterministic native music claims', async () => {
  const subject = pipeline();
  assert.deepEqual(subject.capabilities, {
    resolvesProductionMediaFiles: true,
    productionMediaScopes: ['music-ordinary-tracks-and-conventional-albums']
  });

  const album = candidate('Z:\\Music\\Album One');
  const track = candidate('Z:\\Music\\Album One\\01 Song.flac', 'file');
  const direct = await subject.resolve({
    parent: root,
    root,
    collectionContext,
    candidates: [album],
    peekDirectory: peek(new Map([[album.identityPath, snapshot([track])]]))
  });
  assert.equal(direct.claims.length, 1);
  assert.equal(direct.claims[0].nativeType, musicAlbumNativeType);
  assert.equal(direct.claims[0].draft.Name, 'Album One');
  assert.equal(direct.claims[0].traversal, 'children');
  assert.deepEqual(direct.claims[0].draft.columns, { UnratedType: 'Music' });
  assert.deepEqual(direct.claims[0].draft.initialColumns, { Artists: [], AlbumArtists: [] });
  assert.equal(Object.hasOwn(direct.claims[0].draft.initialColumns, 'PresentationUniqueKey'), false);

  const albumParent = {
    Id: direct.claims[0].Id,
    Path: album.identityPath,
    NativeType: musicAlbumNativeType,
    Type: 'MusicAlbum',
    IsFolder: true,
    TopParentId: root.Id
  };
  const tracks = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: [track] });
  assert.equal(tracks.claims.length, 1);
  assert.equal(tracks.claims[0].nativeType, audioNativeType);
  assert.equal(tracks.claims[0].draft.Name, '01 Song');
  assert.deepEqual(tracks.claims[0].draft.columns, { IsInMixedFolder: true, UnratedType: 'Music' });
  assert.deepEqual(tracks.claims[0].draft.initialColumns, { Artists: [], AlbumArtists: [] });

  const artist = candidate('Z:\\Music\\Artist');
  const nestedAlbum = candidate('Z:\\Music\\Artist\\Album Two');
  const nestedTrack = candidate('Z:\\Music\\Artist\\Album Two\\Track.mp3', 'file');
  const artistSnapshots = new Map([
    [artist.identityPath, snapshot([nestedAlbum, candidate(`${artist.identityPath}\\Loose.mp3`, 'file')])],
    [nestedAlbum.identityPath, snapshot([nestedTrack])]
  ]);
  const artistResult = await subject.resolve({
    parent: root,
    root,
    collectionContext,
    candidates: [artist],
    peekDirectory: peek(artistSnapshots)
  });
  assert.equal(artistResult.claims.length, 1);
  assert.equal(artistResult.claims[0].nativeType, musicArtistNativeType);
  assert.deepEqual(artistResult.claims[0].draft.columns, { UnratedType: 'Music' });
  assert.equal(Object.hasOwn(artistResult.claims[0].draft, 'initialColumns'), false);

  const artistParent = {
    Id: artistResult.claims[0].Id,
    Path: artist.identityPath,
    NativeType: musicArtistNativeType,
    Type: 'MusicArtist',
    IsFolder: true,
    TopParentId: root.Id
  };
  const nested = await subject.resolve({
    parent: artistParent,
    root,
    collectionContext,
    candidates: [nestedAlbum],
    peekDirectory: peek(artistSnapshots)
  });
  assert.equal(nested.claims[0].nativeType, musicAlbumNativeType);
});

test('music leaf scope accepts ordinary native audio in albums, artists and library roots', async t => {
  const subject = pipeline();
  const albumParent = {
    Id: '10000000-0000-0000-0000-000000000002',
    Path: 'Z:\\Music\\Album',
    NativeType: musicAlbumNativeType,
    Type: 'MusicAlbum',
    IsFolder: true,
    TopParentId: root.Id
  };
  for (const extension of safeAudioExtensions) await t.test(extension, async () => {
    const file = candidate(`${albumParent.Path}\\Track${extension}`, 'file');
    const result = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: [file] });
    assert.equal(result.claims[0].nativeType, audioNativeType);
    assert.deepEqual(result.withheldPaths, []);
  });
  for (const extension of withheldAudioExtensions) await t.test(`withhold ${extension}`, async () => {
    const file = candidate(`${albumParent.Path}\\Track${extension}`, 'file');
    const result = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: [file] });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [file.identityPath]);
  });
  for (const extension of ['.FLAC', '.Mp3', '.YmF']) await t.test(`case-insensitive ${extension}`, async () => {
    const file = candidate(`${albumParent.Path}\\Track${extension}`, 'file');
    const result = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: [file] });
    assert.equal(result.claims[0].nativeType, audioNativeType);
    assert.deepEqual(result.withheldPaths, []);
  });

  for (const parent of [root, { ...albumParent, NativeType: musicArtistNativeType, Type: 'MusicArtist' }]) {
    const file = candidate(`${parent.Path}\\Loose.mp3`, 'file');
    const result = await subject.resolve({ parent, root, collectionContext, candidates: [file] });
    assert.equal(result.claims[0].nativeType, audioNativeType);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('CUE files identify Albums while only actual audio files become tracks', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Cue Album');
  const cue = candidate(`${album.identityPath}\\Album.CUE`, 'file');
  const track = candidate(`${album.identityPath}\\Track.flac`, 'file');
  for (const files of [[cue, track], [cue]]) {
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
      peekDirectory: async () => snapshot(files) });
    assert.equal(result.claims[0].nativeType, musicAlbumNativeType);
    assert.deepEqual(result.withheldPaths, []);
    const parent = { Id: result.claims[0].Id, Path: album.identityPath, NativeType: musicAlbumNativeType };
    const children = await subject.resolve({ parent, root, collectionContext, candidates: files });
    assert.deepEqual(children.claims.map(claim => claim.nativeType), files.includes(track) ? [audioNativeType] : []);
    assert.deepEqual(children.withheldPaths, []);
  }
  const loose = await subject.resolve({ parent: root, root, collectionContext,
    candidates: [candidate('Z:\\Music\\Loose.cue', 'file')] });
  assert.deepEqual(loose.claims, []);
  assert.deepEqual(loose.withheldPaths, []);

  const disc = candidate(`${album.identityPath}\\CD1`);
  const discCue = candidate(`${disc.identityPath}\\Disc.cue`, 'file');
  for (const files of [[discCue], [discCue, candidate(`${disc.identityPath}\\Track.flac`, 'file')]]) {
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
      peekDirectory: peek(new Map([[album.identityPath, snapshot([disc])], [disc.identityPath, snapshot(files)]])) });
    assert.equal(result.claims[0].nativeType, musicAlbumNativeType);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('music STRM files identify Albums and preserve shortcut Audio identity without claiming other libraries', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Remote Album');
  const shortcut = candidate(`${album.identityPath}\\Radio.StRm`, 'file');
  const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
    peekDirectory: async () => snapshot([shortcut]) });
  assert.equal(result.claims[0].nativeType, musicAlbumNativeType);
  assert.deepEqual(result.withheldPaths, []);
  const parent = { Id: result.claims[0].Id, Path: album.identityPath, NativeType: musicAlbumNativeType };
  for (const owner of [root, parent]) {
    const tracks = await subject.resolve({ parent: owner, root, collectionContext, candidates: [shortcut] });
    assert.equal(tracks.claims[0].nativeType, audioNativeType);
    assert.equal(tracks.claims[0].draft.Name, 'Radio');
    assert.equal(tracks.claims[0].draft.columns.IsInMixedFolder, true);
    assert.deepEqual(tracks.claims[0].draft.data, { IsShortcut: true });
    assert.deepEqual(tracks.withheldPaths, []);
  }
  const resolver = createAudioItemResolver();
  for (const collectionType of ['movies', 'tvshows', 'books', null]) {
    assert.equal(resolver.resolveFile({ parent: root, collectionContext: { ...collectionContext, collectionType },
      candidate: shortcut, deletionSafe: true }), null);
  }
  assert.deepEqual(resolver.resolveFile({ parent: root, collectionContext, candidate: shortcut, deletionSafe: false }), { withhold: true });
});

test('untyped libraries admit Audio files while video conflicts and playlists retain their resolver precedence', async () => {
  const context = { ...collectionContext, collectionType: null };
  const track = candidate('Z:\\Music\\Track.flac', 'file');
  const conflicts = ['.3gp', '.nsv', '.rm', '.strm'].map(extension => candidate(`Z:\\Music\\Clip${extension}`, 'file'));
  const cue = candidate('Z:\\Music\\Album.cue', 'file');
  const playlist = candidate('Z:\\Music\\Tracks.pls', 'file');
  const subject = new DirectoryItemResolverPipeline({
    resolvers: [createPlaylistItemResolver(), createAudioItemResolver()], programDataPath
  });
  const result = await subject.resolve({ parent: root, root, collectionContext: context,
    candidates: [track, ...conflicts, cue, playlist] });
  assert.equal(result.claims.find(value => value.identityPath === track.identityPath).nativeType, audioNativeType);
  assert.equal(result.claims.find(value => value.identityPath === playlist.identityPath).nativeType,
    'MediaBrowser.Controller.Playlists.Playlist');
  assert.deepEqual(new Set(result.unclaimedPaths), new Set([...conflicts, cue].map(value => value.identityPath)));
  assert.deepEqual(result.withheldPaths, []);
  for (const collectionType of ['unknown', 'movies', 'tvshows', 'books']) {
    const other = await subject.resolve({ parent: root, root,
      collectionContext: { ...context, collectionType }, candidates: [track] });
    assert.deepEqual(other.claims, []);
  }
  const weak = await subject.resolve({ parent: root, root, collectionContext: context,
    candidates: [track], deletionSafe: false });
  assert.deepEqual(weak.claims, []);
  assert.deepEqual(weak.withheldPaths, [track.identityPath]);
});

test('music album and disc inference ignores unrelated videos while retaining playlist leaf priority', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Album');
  const track = candidate(`${album.identityPath}\\Track.rm`, 'file');
  const clip = candidate(`${album.identityPath}\\Clip.mkv`, 'file');
  const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
    peekDirectory: async () => snapshot([track, clip]) });
  assert.equal(result.claims[0].nativeType, musicAlbumNativeType);
  assert.deepEqual(result.withheldPaths, []);
  const parent = { Id: result.claims[0].Id, Path: album.identityPath, NativeType: musicAlbumNativeType };
  const children = await subject.resolve({ parent, root, collectionContext, candidates: [track, clip] });
  assert.deepEqual(children.claims.map(value => value.identityPath), [track.identityPath]);
  assert.deepEqual(children.unclaimedPaths, [clip.identityPath]);
  assert.deepEqual(children.withheldPaths, []);

  const disc = candidate(`${album.identityPath}\\CD1`);
  const discFiles = ['Track.flac', 'Clip.mkv'].map(name => candidate(`${disc.identityPath}\\${name}`, 'file'));
  const snapshots = new Map([[album.identityPath, snapshot([disc, clip])], [disc.identityPath, snapshot(discFiles)]]);
  const multi = await subject.resolve({ parent: root, root, collectionContext, candidates: [album], peekDirectory: peek(snapshots) });
  assert.equal(multi.claims[0].nativeType, musicAlbumNativeType);
  const nested = await subject.resolve({ parent, root, collectionContext, candidates: [disc], peekDirectory: peek(snapshots) });
  assert.equal(nested.claims[0].nativeType, root.NativeType);
  assert.deepEqual(nested.withheldPaths, []);

  const playlist = candidate(`${album.identityPath}\\Tracks.pls`, 'file');
  const onlyPlaylist = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
    peekDirectory: async () => snapshot([playlist]) });
  assert.equal(onlyPlaylist.claims[0].nativeType, musicAlbumNativeType, 'ContainsMusic includes the native PLS extension');
  const withPlaylists = new DirectoryItemResolverPipeline({
    resolvers: [createPlaylistItemResolver(), createAudioItemResolver()], programDataPath
  });
  const leaf = await withPlaylists.resolve({ parent, root, collectionContext, candidates: [playlist, track, clip] });
  assert.equal(leaf.claims.find(value => value.identityPath === playlist.identityPath).nativeType,
    'MediaBrowser.Controller.Playlists.Playlist');
  assert.equal(leaf.claims.find(value => value.identityPath === track.identityPath).nativeType, audioNativeType);
  assert.deepEqual(leaf.withheldPaths, []);
});

test('an exact artist.nfo marker identifies an Artist before album inference without allowing nested Artists', async () => {
  const subject = pipeline(), artist = candidate('Z:\\Music\\Marked Artist');
  const marker = candidate(`${artist.identityPath}\\artist.nfo`, 'file');
  for (const contents of [[marker], [marker, candidate(`${artist.identityPath}\\Track.flac`, 'file')]]) {
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [artist],
      peekDirectory: async () => snapshot(contents) });
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, musicArtistNativeType);
    assert.equal(result.claims[0].traversal, 'children');
  }
  for (const parentType of [musicArtistNativeType, musicAlbumNativeType]) {
    const parent = { ...root, Id: '10000000-0000-0000-0000-000000000099', NativeType: parentType };
    for (const hasTrack of [false, true]) {
      const result = await subject.resolve({ parent, root, collectionContext, candidates: [artist],
        peekDirectory: async () => snapshot(hasTrack ? [marker, candidate(`${artist.identityPath}\\Track.flac`, 'file')] : [marker]) });
      assert.equal(result.claims.length, 1);
      assert.equal(result.claims[0].nativeType,
        hasTrack && parentType === musicArtistNativeType ? musicAlbumNativeType : root.NativeType);
      assert.deepEqual(result.withheldPaths, []);
    }
  }
  for (const [contents, strong] of [
    [[marker, candidate(`${artist.identityPath}\\playlist.xml`, 'file')], true],
    [[marker], false]
  ]) {
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [artist],
      peekDirectory: async () => snapshot(contents, strong) });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [artist.identityPath]);
  }
});

test('named release groups identify Artists and ordinary Folder traversal finds their Albums', async () => {
  const subject = pipeline(), artist = candidate('Z:\\Music\\Grouped Artist');
  const albums = candidate(`${artist.identityPath}\\Albums`), eps = candidate(`${artist.identityPath}\\ePs`);
  const release = candidate(`${albums.identityPath}\\Release`);
  const track = candidate(`${release.identityPath}\\Track.flac`, 'file');
  const snapshots = new Map([
    [artist.identityPath, snapshot([albums, eps])],
    [albums.identityPath, snapshot([release])],
    [eps.identityPath, snapshot([])],
    [release.identityPath, snapshot([track, candidate(`${release.identityPath}\\artist.nfo`, 'file')])]
  ]);
  const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [artist],
    peekDirectory: peek(snapshots) });
  assert.equal(result.claims[0].nativeType, musicArtistNativeType);
  const artistParent = { Id: result.claims[0].Id, Path: artist.identityPath, NativeType: musicArtistNativeType };
  const groups = await subject.resolve({ parent: artistParent, root, collectionContext: { ...collectionContext, parents: [root] },
    candidates: [albums, eps], peekDirectory: peek(snapshots) });
  assert.deepEqual(groups.claims.map(claim => claim.nativeType), [root.NativeType, root.NativeType]);
  assert.deepEqual(groups.withheldPaths, []);
  const groupParent = { Id: groups.claims[0].Id, Path: albums.identityPath, NativeType: root.NativeType };
  const releases = await subject.resolve({ parent: groupParent, root,
    collectionContext: { ...collectionContext, parents: [artistParent, root] }, candidates: [release],
    peekDirectory: peek(snapshots) });
  assert.equal(releases.claims[0].nativeType, musicAlbumNativeType);
  assert.deepEqual(releases.withheldPaths, []);

  for (const contents of [[], [candidate(`${eps.identityPath}\\Track.mp3`, 'file')]]) {
    snapshots.set(eps.identityPath, snapshot(contents));
    const emptyArtist = await subject.resolve({ parent: root, root, collectionContext, candidates: [artist],
      peekDirectory: peek(new Map([[artist.identityPath, snapshot([eps])], [eps.identityPath, snapshot(contents)]])) });
    assert.equal(emptyArtist.claims[0].nativeType, musicArtistNativeType, 'even an empty named group identifies its Artist');
    const group = await subject.resolve({ parent: artistParent, root, collectionContext, candidates: [eps],
      peekDirectory: peek(snapshots) });
    assert.equal(group.claims[0].nativeType, contents.length ? musicAlbumNativeType : root.NativeType,
      'a group name alone does not suppress album inference for direct tracks');
  }
});

test('Artist and Album ancestors remain authoritative across intermediate physical Folders', async () => {
  const subject = pipeline();
  const artist = { Id: '10000000-0000-0000-0000-000000000004', Path: 'Z:\\Music\\Artist', NativeType: musicArtistNativeType };
  const group = { Id: '10000000-0000-0000-0000-000000000005', Path: `${artist.Path}\\Albums`, NativeType: root.NativeType };
  const nested = candidate(`${group.Path}\\Nested`), marker = candidate(`${nested.identityPath}\\artist.nfo`, 'file');
  const result = await subject.resolve({ parent: group, root,
    collectionContext: { ...collectionContext, parents: [artist, root] }, candidates: [nested],
    peekDirectory: async () => snapshot([marker]) });
  assert.equal(result.claims[0].nativeType, root.NativeType, 'an artist marker cannot create an Artist below another Artist');

  const album = { Id: '10000000-0000-0000-0000-000000000006', Path: `${group.Path}\\Release`, NativeType: musicAlbumNativeType };
  const disc = { Id: '10000000-0000-0000-0000-000000000007', Path: `${album.Path}\\CD1`, NativeType: root.NativeType };
  const bonus = candidate(`${disc.Path}\\Bonus`), track = candidate(`${bonus.identityPath}\\Track.flac`, 'file');
  const folders = await subject.resolve({ parent: disc, root,
    collectionContext: { ...collectionContext, parents: [album, group, artist, root] }, candidates: [bonus],
    peekDirectory: async () => snapshot([track, candidate(`${bonus.identityPath}\\artist.nfo`, 'file')]) });
  assert.equal(folders.claims[0].nativeType, root.NativeType, 'an Album ancestor prevents another Album or Artist');
  assert.deepEqual(folders.withheldPaths, []);
});

test('native multipart names identify an Album without inferring an Artist or a disc number', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Multi Disc Album');
  for (const name of ['CD1', 'Disc 01 (Title)', 'Disc04(Title)', 'cd - 1', 'digital media 1',
    'disk 2', 'volume 2', 'vol.2', 'part 1', 'act 2']) {
    const disc = candidate(`${album.identityPath}\\${name}`);
    const track = candidate(`${disc.identityPath}\\01 Track.flac`, 'file');
    const snapshots = new Map([
      [album.identityPath, snapshot([disc])],
      [disc.identityPath, snapshot([track])]
    ]);
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [album],
      peekDirectory: peek(snapshots) });
    assert.equal(result.claims.length, 1, name);
    assert.equal(result.claims[0].nativeType, musicAlbumNativeType, name);

    const albumParent = { Id: result.claims[0].Id, Path: album.identityPath, NativeType: musicAlbumNativeType };
    const discs = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: [disc],
      peekDirectory: peek(snapshots) });
    assert.equal(discs.claims.length, 1, name);
    assert.equal(discs.claims[0].nativeType, root.NativeType, name);
    assert.equal(discs.claims[0].traversal, 'children');
    const discParent = { Id: discs.claims[0].Id, Path: disc.identityPath, NativeType: root.NativeType };
    const tracks = await subject.resolve({ parent: discParent, root, collectionContext, candidates: [track] });
    assert.equal(tracks.claims[0].nativeType, audioNativeType);
    assert.equal(Object.hasOwn(tracks.claims[0].draft.columns, 'ParentIndexNumber'), false);
  }
});

test('Artist inference recognizes a multi-disc Album and ignores empty siblings when identifying the Album', async () => {
  const subject = pipeline(), artist = candidate('Z:\\Music\\Artist');
  const album = candidate(`${artist.identityPath}\\Album`);
  const discs = ['CD1', 'CD2', 'Artwork'].map(name => candidate(`${album.identityPath}\\${name}`));
  const snapshots = new Map([
    [artist.identityPath, snapshot([album])],
    [album.identityPath, snapshot(discs)],
    ...discs.map((disc, index) => [disc.identityPath,
      snapshot(index < 2 ? [candidate(`${disc.identityPath}\\01 Track.flac`, 'file')] : [])])
  ]);
  const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [artist],
    peekDirectory: peek(snapshots) });
  assert.equal(result.claims[0].nativeType, musicArtistNativeType);
  const parent = { Id: result.claims[0].Id, Path: artist.identityPath, NativeType: musicArtistNativeType };
  const albums = await subject.resolve({ parent, root, collectionContext, candidates: [album],
    peekDirectory: peek(snapshots) });
  assert.equal(albums.claims[0].nativeType, musicAlbumNativeType);

  const albumParent = { Id: albums.claims[0].Id, Path: album.identityPath, NativeType: musicAlbumNativeType };
  const folders = await subject.resolve({ parent: albumParent, root, collectionContext, candidates: discs,
    peekDirectory: peek(snapshots) });
  assert.deepEqual(folders.claims.map(claim => claim.nativeType), discs.map(() => root.NativeType));

  // Disc names only affect album inference. A direct child of an Artist can
  // itself be an Album named CD1, because it has no Album ancestor.
  const namedAlbum = candidate(`${artist.identityPath}\\CD1`);
  const named = await subject.resolve({ parent, root, collectionContext, candidates: [namedAlbum],
    peekDirectory: async () => snapshot([candidate(`${namedAlbum.identityPath}\\Track.flac`, 'file')]) });
  assert.equal(named.claims[0].nativeType, musicAlbumNativeType);
});

test('weak snapshots and playlist directories are withheld', async t => {
  const subject = pipeline();
  const directory = candidate('Z:\\Music\\Candidate');
  const track = candidate(`${directory.identityPath}\\Track.flac`, 'file');
  const cases = [
    ['weak snapshot', new Map([[directory.identityPath, snapshot([track], false)]])],
    ['playlist xml', new Map([[directory.identityPath, snapshot([candidate(`${directory.identityPath}\\playlist.xml`, 'file'), track])]])],
    ['playlist name', new Map([[directory.identityPath, snapshot([track])]])]
  ];
  for (const [name, snapshots] of cases) await t.test(name, async () => {
    const selected = name === 'playlist name' ? { ...directory, entry: { ...directory.entry, name: 'Mix [playlist]' } } : directory;
    const adjusted = name === 'playlist name'
      ? new Map([[selected.identityPath, snapshots.get(directory.identityPath)]]) : snapshots;
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [selected],
      peekDirectory: peek(adjusted) });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [selected.identityPath]);
  });
});

test('strong ordinary Folders remain traversable before Artist or Album inference', async () => {
  const subject = pipeline(), directory = candidate('Z:\\Music\\Ordinary');
  for (const files of [[], [candidate(`${directory.identityPath}\\Artist.nfo`, 'file')]]) {
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [directory],
      peekDirectory: async () => snapshot(files) });
    assert.equal(result.claims[0].nativeType, root.NativeType);
    assert.equal(result.claims[0].traversal, 'children');
    assert.deepEqual(result.withheldPaths, []);
  }
  const parent = { Id: '10000000-0000-0000-0000-000000000010', Path: directory.identityPath, NativeType: root.NativeType };
  const artist = candidate(`${directory.identityPath}\\Artist`), album = candidate(`${artist.identityPath}\\Album`);
  const snapshots = new Map([
    [artist.identityPath, snapshot([album])],
    [album.identityPath, snapshot([candidate(`${album.identityPath}\\Track.flac`, 'file')])]
  ]);
  const result = await subject.resolve({ parent, root, collectionContext: { ...collectionContext, parents: [root] },
    candidates: [artist], peekDirectory: peek(snapshots) });
  assert.equal(result.claims[0].nativeType, musicArtistNativeType);
  assert.deepEqual(result.withheldPaths, []);
});

test('true root children retain Folder identity unless an explicit artist marker identifies them', async () => {
  const subject = pipeline(), directory = candidate('Z:\\Music\\Library');
  const album = candidate(`${directory.identityPath}\\Album`);
  const track = candidate(`${directory.identityPath}\\Track.flac`, 'file');
  const marker = candidate(`${directory.identityPath}\\artist.nfo`, 'file');
  const parent = { ...root, IsRoot: true };
  for (const contents of [[track], [album], [marker, track]]) {
    const result = await subject.resolve({ parent, root, collectionContext, candidates: [directory],
      peekDirectory: peek(new Map([
        [directory.identityPath, snapshot(contents)],
        [album.identityPath, snapshot([candidate(`${album.identityPath}\\Track.flac`, 'file')])]
      ])) });
    assert.equal(result.claims[0].nativeType, contents.includes(marker) ? musicArtistNativeType : root.NativeType);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('non-numeric disc names and empty siblings use ordinary Artist and Album inference', async () => {
  const subject = pipeline(), directory = candidate('Z:\\Music\\Artist');
  for (const name of ['dvd a', 'CD A', 'part A']) {
    const album = candidate(`${directory.identityPath}\\${name}`);
    const track = candidate(`${album.identityPath}\\Track.flac`, 'file');
    const snapshots = new Map([
      [directory.identityPath, snapshot([album])],
      [album.identityPath, snapshot([track])]
    ]);
    const result = await subject.resolve({ parent: root, root, collectionContext, candidates: [directory],
      peekDirectory: peek(snapshots) });
    assert.equal(result.claims[0].nativeType, musicArtistNativeType, name);
    assert.deepEqual(result.withheldPaths, []);
    const parent = { Id: result.claims[0].Id, Path: directory.identityPath, NativeType: musicArtistNativeType };
    const children = await subject.resolve({ parent, root, collectionContext, candidates: [album],
      peekDirectory: peek(snapshots) });
    assert.equal(children.claims[0].nativeType, musicAlbumNativeType, name);
    assert.deepEqual(children.withheldPaths, []);
  }

  const album = candidate(`${directory.identityPath}\\Album`);
  const albumTrack = candidate(`${album.identityPath}\\Track.mp3`, 'file');
  const second = candidate(`${directory.identityPath}\\Unproved`);
  const artist = await subject.resolve({
    parent: root,
    root,
    collectionContext,
    candidates: [directory],
    peekDirectory: peek(new Map([
      [directory.identityPath, snapshot([album, second])],
      [album.identityPath, snapshot([albumTrack])],
      [second.identityPath, snapshot([], true)]
    ]))
  });
  assert.equal(artist.claims[0].nativeType, musicArtistNativeType);
  assert.deepEqual(artist.withheldPaths, []);
});

test('multi-disc inference retains weak, playlist-directory and collection-override boundaries', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Album'), disc = candidate(`${album.identityPath}\\CD1`);
  const track = candidate(`${disc.identityPath}\\Track.flac`, 'file');
  for (const [contents, context] of [
    [snapshot([track], false), collectionContext],
    [snapshot([track, candidate(`${disc.identityPath}\\playlist.xml`, 'file')]), collectionContext],
    [snapshot([track]), { ...collectionContext,
      contentTypeOverrides: [{ path: disc.identityPath, collectionType: 'movies' }] }]
  ]) {
    const result = await subject.resolve({ parent: root, root, collectionContext: context, candidates: [album],
      peekDirectory: peek(new Map([[album.identityPath, snapshot([disc])], [disc.identityPath, contents]])) });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [album.identityPath]);
  }

  const artist = { ...root, Id: '10000000-0000-0000-0000-000000000003', NativeType: musicArtistNativeType };
  const otherAlbum = candidate(`${album.identityPath}\\Other Album`);
  const result = await subject.resolve({ parent: artist, root, collectionContext, candidates: [album],
    peekDirectory: peek(new Map([
      [album.identityPath, snapshot([disc, otherAlbum])], [disc.identityPath, snapshot([track])],
      [otherAlbum.identityPath, snapshot([candidate(`${otherAlbum.identityPath}\\Track.flac`, 'file')])]
    ])) });
  assert.equal(result.claims[0].nativeType, root.NativeType,
    'music in a non-disc child prevents album inference but remains a physical Folder under the Artist');
  assert.deepEqual(result.withheldPaths, []);
});

test('the selected native music type resolves albums while an explicit non-music child override withholds them', async () => {
  const subject = pipeline(), album = candidate('Z:\\Music\\Album'), track = candidate(album.identityPath + '\\Track.flac', 'file');
  const ordered = { ...collectionContext, collections: [{ collectionType: 'music' }, { collectionType: 'movies' }] };
  const result = await subject.resolve({ parent: root, root, collectionContext: ordered, candidates: [album],
    peekDirectory: peek(new Map([[album.identityPath, snapshot([track])]])) });
  assert.equal(result.claims[0].nativeType, musicAlbumNativeType);
  const withheld = await subject.resolve({ parent: root, root,
    collectionContext: { ...ordered, contentTypeOverrides: [{ path: album.identityPath, collectionType: 'movies' }] }, candidates: [album],
    peekDirectory: peek(new Map([[album.identityPath, snapshot([track])]])) });
  assert.deepEqual(withheld.claims, []); assert.deepEqual(withheld.withheldPaths, [album.identityPath]);
  const exact = await subject.resolve({ parent: root, root,
    collectionContext: { ...ordered, collectionType: 'movies', contentTypeOverrides: [{ path: album.identityPath, collectionType: 'music' }] }, candidates: [album],
    peekDirectory: peek(new Map([[album.identityPath, snapshot([track])]])) });
  assert.equal(exact.claims[0].nativeType, musicAlbumNativeType);
});

test('a nested non-music override prevents the outer directory from being claimed as an Artist', async () => {
  const subject = pipeline();
  const artist = candidate('Z:\\Music\\Artist');
  const album = candidate(`${artist.identityPath}\\Album`);
  const track = candidate(`${album.identityPath}\\Track.flac`, 'file');
  const result = await subject.resolve({
    parent: root,
    root,
    collectionContext: {
      ...collectionContext,
      contentTypeOverrides: [{ path: album.identityPath, collectionType: 'movies' }]
    },
    candidates: [artist],
    peekDirectory: peek(new Map([
      [artist.identityPath, snapshot([album])],
      [album.identityPath, snapshot([track])]
    ]))
  });
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.withheldPaths, [artist.identityPath]);
});
