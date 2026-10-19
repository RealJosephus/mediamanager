import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
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
  '.669', '.aa', '.aac', '.aax', '.ac3', '.act', '.adp', '.adplug', '.adx', '.afc', '.amf', '.aif',
  '.aifc', '.aiff', '.alac', '.amr', '.ape', '.ast', '.au', '.awb', '.cda', '.dmf', '.dsf', '.dsm',
  '.dsp', '.dts', '.dvf', '.eac3', '.ec3', '.far', '.flac', '.gdm', '.gsm', '.gym', '.hps', '.imf',
  '.it', '.m15', '.m4a', '.m4b', '.mac', '.med', '.mka', '.mmf', '.mod', '.mogg', '.mp2', '.mp3',
  '.mpa', '.mpc', '.mpp', '.mp+', '.msv', '.nmf', '.nsf', '.oga', '.ogg', '.okt', '.opus', '.ra',
  '.rf64', '.s3m', '.sfx', '.shn', '.sid', '.stm', '.ult', '.uni', '.vox', '.wav', '.wma', '.wv',
  '.xm', '.xsp', '.ymf'
]);
const withheldAudioExtensions = Object.freeze([
  '.3gp', '.cue', '.nsv', '.pls', '.rm', '.strm', '.m3u', '.m3u8', '.wpl', '.zpl'
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
    productionMediaScopes: ['conventional-music-artist-album-tracks']
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
    [artist.identityPath, snapshot([nestedAlbum])],
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

test('music leaf scope accepts ordinary native audio only below a proven Album', async t => {
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
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [file.identityPath]);
  }
});

test('weak, hybrid, playlist, multi-disc and incompletely proved music directories are withheld', async t => {
  const subject = pipeline();
  const directory = candidate('Z:\\Music\\Candidate');
  const track = candidate(`${directory.identityPath}\\Track.flac`, 'file');
  const album = candidate(`${directory.identityPath}\\Album`);
  const albumTrack = candidate(`${album.identityPath}\\Track.mp3`, 'file');

  const cases = [
    ['weak snapshot', new Map([[directory.identityPath, snapshot([track], false)]])],
    ['hybrid artist', new Map([[directory.identityPath, snapshot([track, album])], [album.identityPath, snapshot([albumTrack])]])],
    ['artist nfo', new Map([[directory.identityPath, snapshot([candidate(`${directory.identityPath}\\artist.nfo`, 'file')])]])],
    ['playlist xml', new Map([[directory.identityPath, snapshot([candidate(`${directory.identityPath}\\playlist.xml`, 'file'), track])]])],
    ['playlist name', new Map([[directory.identityPath, snapshot([track])]])],
    ['unknown directory', new Map([[directory.identityPath, snapshot([])]])]
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

  for (const name of ['Disc 01 (Title)', 'Disc04(Title)', 'cd - 1', 'digital media 1', 'dvd a']) await t.test(name, async () => {
    const disc = candidate(`${directory.identityPath}\\${name}`);
    const discTrack = candidate(`${disc.identityPath}\\Track.flac`, 'file');
    const result = await subject.resolve({
      parent: root,
      root,
      collectionContext,
      candidates: [directory],
      peekDirectory: peek(new Map([
        [directory.identityPath, snapshot([disc])],
        [disc.identityPath, snapshot([discTrack])]
      ]))
    });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });

  const second = candidate(`${directory.identityPath}\\Unproved`);
  const incompleteArtist = await subject.resolve({
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
  assert.deepEqual(incompleteArtist.claims, []);
  assert.deepEqual(incompleteArtist.withheldPaths, [directory.identityPath]);
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
