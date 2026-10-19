import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createTvItemResolver, episodeNativeType, seasonNativeType, seriesNativeType } from '../../src/library/tv-item-resolver.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { setResolverProviderIdsFromPath } from '../../src/library/resolver-initial-values.js';
import { StorageError } from '../../src/storage/errors.js';

const root = { Id: '10000000-0000-0000-0000-000000000001', Path: 'Z:\\TV',
  Type: 'Folder', NativeType: 'MediaBrowser.Controller.Entities.Folder', IsFolder: true };
const series = { Id: '10000000-0000-0000-0000-000000000002', Path: 'Z:\\TV\\Example Show',
  Type: 'Series', NativeType: seriesNativeType, IsFolder: true, TopParentId: root.Id };
const season = { Id: '10000000-0000-0000-0000-000000000003', Path: series.Path + '\\Season 1',
  Type: 'Season', NativeType: seasonNativeType, IsFolder: true, SeriesId: series.Id, IndexNumber: 1 };
const collectionContext = { collectionType: 'tvshows', contentTypeOverrides: [], libraryOptions: { SeasonZeroDisplayName: 'Bonus Episodes' } };
const pipeline = options => new DirectoryItemResolverPipeline({ resolvers: [createTvItemResolver(options)], programDataPath: 'C:\\ProgramData\\MediaManager' });
function candidate(identityPath, kind = 'directory') {
  return { identityPath, accessPath: identityPath.replace('Z:\\TV', '/tv').replaceAll('\\', '/'),
    entry: { kind, name: identityPath.split('\\').at(-1), size: kind === 'file' ? 5 : undefined } };
}
const snapshot = (children = [], deletionSafe = true) => ({ candidates: children,
  listing: { deletionSafe, entries: children.map(child => child.entry) } });
const resolve = (subject, parent, candidates, extra = {}) => subject.resolve({ parent, root, collectionContext,
  candidates, peekDirectory: async () => snapshot(), ...extra });

test('ordinary TV admission accepts a flat Series without requiring a conventional season child', async () => {
  const subject = pipeline();
  assert.deepEqual(subject.capabilities.productionMediaScopes, ['tv-ordinary-video-files']);
  const directory = candidate('Z:\\TV\\Example Show (2024) [tvdbid=123]');
  const flat = candidate(directory.identityPath + '\\Example.Show.S02E04.1080p.mkv', 'file');
  const result = await resolve(subject, root, [directory], { peekDirectory: async () => snapshot([flat]) });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, seriesNativeType);
  assert.equal(result.claims[0].draft.Name, 'Example Show');
  assert.deepEqual(result.claims[0].draft.initialColumns, { ProductionYear: 2024 });
  assert.equal(result.claims[0].traversal, 'children');
  const episodes = await resolve(subject, { ...series, Path: directory.identityPath }, [flat]);
  assert.equal(episodes.claims[0].nativeType, episodeNativeType);
  assert.equal(episodes.claims[0].draft.initialColumns, undefined,
    'metadata resolves the filename after the actual Series display order is available');
});

test('untyped Series detection uses the exact marker or a direct named Season directory', async () => {
  const mixed = { ...collectionContext, collectionType: null };
  const directory = candidate('Z:\\TV\\Detected Show (2024)');
  for (const [name, kind] of [['tvshow.nfo', 'file'], ['tvshow.nfo', 'directory'],
    ['Season 2', 'directory'], ['S03', 'directory']]) {
    const child = candidate(directory.identityPath + '\\' + name, kind);
    let readRaw = false;
    const result = await resolve(pipeline(), root, [directory], {
      collectionContext: mixed, peekDirectory: async (value, options) => {
        assert.equal(value, directory);
        readRaw ||= options?.forExtras === true;
        return snapshot([child]);
      }
    });
    assert.equal(readRaw, true, 'Series evidence is read from the raw observation');
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, seriesNativeType);
    assert.equal(result.claims[0].draft.Name, 'Detected Show');
    assert.equal(result.claims[0].draft.initialColumns, undefined,
      'untyped Series discovery leaves the production year to metadata');
    assert.equal(result.claims[0].traversal, 'children');
    assert.deepEqual(result.withheldPaths, []);
  }
  for (const [name, kind] of [['TVSHOW.NFO', 'file'], ['season.nfo', 'file'],
    ['1', 'directory'], ['Specials', 'directory'], ['Show.S01E01.mkv', 'file']]) {
    const result = await resolve(pipeline(), root, [directory], { collectionContext: mixed,
      peekDirectory: async () => snapshot([candidate(directory.identityPath + '\\' + name, kind)]) });
    assert.equal(result.claims[0].nativeType, root.NativeType, `${name} alone is not a Series marker`);
  }
  const contents = [candidate(directory.identityPath + '\\tvshow.nfo', 'file')];
  for (const extra of [
    { parent: { ...root, IsRoot: true }, context: mixed },
    { parent: root, context: { ...mixed, collectionType: 'unknown' } }
  ]) {
    const result = await resolve(pipeline(), extra.parent, [directory], {
      collectionContext: extra.context, peekDirectory: async () => snapshot(contents) });
    assert.equal(result.claims[0].nativeType, root.NativeType);
  }
  const weak = await resolve(pipeline(), root, [directory], { collectionContext: mixed,
    peekDirectory: async () => snapshot(contents, false) });
  assert.deepEqual(weak.claims, []);
  assert.deepEqual(weak.withheldPaths, [directory.identityPath]);
});

test('untyped TV descendants use their real Series and Season ancestors without creating nested Series', async () => {
  const mixed = { ...collectionContext, collectionType: null };
  const seasonDirectory = candidate(series.Path + '\\1');
  const seasons = await resolve(pipeline(), series, [seasonDirectory], { collectionContext: mixed });
  assert.equal(seasons.claims[0].nativeType, seasonNativeType);
  assert.equal(seasons.claims[0].draft.initialColumns.IndexNumber, 1);
  const directory = candidate(season.Path + '\\Archive');
  const marker = candidate(directory.identityPath + '\\tvshow.nfo', 'file');
  const folders = await resolve(pipeline(), season, [directory], {
    collectionContext: { ...mixed, parents: [series, root] }, peekDirectory: async () => snapshot([marker])
  });
  assert.equal(folders.claims[0].nativeType, root.NativeType);
  const nested = { ...root, Id: folders.claims[0].Id, Path: directory.identityPath };
  for (const [parent, parents] of [[series, [root]], [season, [series, root]], [nested, [season, series, root]]]) {
    const file = candidate(parent.Path + '\\Show.S01E02.mkv', 'file');
    const result = await resolve(pipeline(), parent, [file], { collectionContext: { ...mixed, parents } });
    assert.equal(result.claims[0].nativeType, episodeNativeType);
    assert.equal(result.claims[0].identityPath, file.identityPath);
    assert.equal(result.claims[0].draft.initialColumns, undefined);
    assert.deepEqual(result.withheldPaths, []);
  }
  const rootFile = candidate(root.Path + '\\Show.S01E02.mkv', 'file');
  const unrelated = await resolve(pipeline(), root, [rootFile], { collectionContext: mixed });
  assert.deepEqual(unrelated.claims, []);
  assert.deepEqual(unrelated.unclaimedPaths, [rootFile.identityPath]);
});

test('season admission reuses the existing special, numeric and named-season parser', async () => {
  const subject = pipeline();
  for (const [name, index] of [['Specials', 0], ['Season 0', 0], ['S01', 1], ['1', 1], ['Season 200', 200]]) {
    const directory = candidate(series.Path + '\\' + name);
    const result = await resolve(subject, series, [directory]);
    assert.equal(result.claims.length, 1, name);
    assert.equal(result.claims[0].nativeType, seasonNativeType);
    assert.deepEqual(result.claims[0].draft.initialColumns, { IndexNumber: index });
    assert.equal(result.claims[0].draft.Name, index === 0 ? 'Bonus Episodes' : `Season ${index}`);
  }
});

test('an unnumbered Season uses raw recursive video presence and retains its physical name', async () => {
  const directory = candidate(series.Path + '\\Unnumbered');
  const nested = candidate(directory.identityPath + '\\Nested');
  const file = candidate(nested.identityPath + '\\Unnumbered.mkv', 'file');
  const result = await resolve(pipeline(), series, [directory], {
    peekDirectory: async (value, options) => options?.forExtras === true
      ? snapshot(value === directory ? [nested] : [file]) : snapshot()
  });
  assert.deepEqual(result.withheldPaths, []);
  assert.equal(result.claims[0].nativeType, seasonNativeType);
  assert.equal(result.claims[0].draft.Name, 'Unnumbered');
  assert.deepEqual(result.claims[0].draft.initialColumns, { IndexNumber: null });
});

test('directories without qualifying Season video remain ordinary Folders while weak subtrees are withheld', async () => {
  for (const [directoryName, fileName] of [
    ['Unnumbered', null], ['Unnumbered', 'season.nfo'], ['Unnumbered', 'Episode.MKV'],
    ['Unnumbered', 'Episode.disc']
  ]) {
    const directory = candidate(series.Path + '\\' + directoryName);
    const result = await resolve(pipeline(), series, [directory], {
      peekDirectory: async () => snapshot(fileName ? [candidate(directory.identityPath + '\\' + fileName, 'file')] : [])
    });
    assert.deepEqual(result.withheldPaths, []);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, root.NativeType);
    assert.equal(result.claims[0].identityPath, directory.identityPath);
    assert.equal(result.claims[0].traversal, 'children');
  }
  const directory = candidate(series.Path + '\\Unnumbered'), nested = candidate(directory.identityPath + '\\Nested');
  const result = await resolve(pipeline(), series, [directory], {
    peekDirectory: async value => value === directory ? snapshot([nested])
      : snapshot([candidate(nested.identityPath + '\\Episode.mkv', 'file')], false)
  });
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.withheldPaths, [directory.identityPath]);
});

test('ordinary Episode files do not require one terminal SxxEyy marker or unique parsed numbers', async () => {
  const names = ['Show.S02E01.mkv', 'Show.S01E01-E02.mkv', 'Show.S01E01.S01E02.mkv',
    'Show.1080p.S01E01.mkv', 'Show.S01E01-1080p.mkv', 'Show.2026-01-02.mkv', 'Unnumbered.mkv'];
  const candidates = names.map(name => candidate(season.Path + '\\' + name, 'file'));
  const result = await resolve(pipeline(), season, candidates);
  assert.deepEqual(result.withheldPaths, []);
  assert.deepEqual(result.claims.map(claim => claim.identityPath), candidates.map(value => value.identityPath));
  for (const claim of result.claims) {
    assert.equal(claim.nativeType, episodeNativeType);
    assert.equal(claim.draft.initialColumns, undefined);
    assert.deepEqual(claim.draft.data, { VideoType: 'VideoFile' });
    assert.deepEqual(claim.localAlternates, [], 'ordinary Episode admission does not invent a version family');
  }
});

test('a TV library root admits ordinary Episode files without inventing a Series', async () => {
  const file = candidate(root.Path + '\\Flat.S01E01.mkv', 'file');
  const result = await resolve(pipeline(), root, [file]);
  assert.deepEqual(result.withheldPaths, []);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, episodeNativeType);
  assert.equal(result.claims[0].identityPath, file.identityPath);
});

test('STRM Episode files keep their physical identity and shortcut flag', async () => {
  const nested = { ...root, Id: '10000000-0000-0000-0000-000000000004', Path: season.Path + '\\Archive' };
  for (const [parent, parents] of [[root, []], [series, [root]], [season, [series, root]], [nested, [season, series, root]]]) {
    const file = candidate(parent.Path + '\\Show.S01E02.STRM', 'file');
    const result = await resolve(pipeline(), parent, [file], {
      collectionContext: { ...collectionContext, parents }
    });
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, episodeNativeType);
    assert.equal(result.claims[0].identityPath, file.identityPath);
    assert.deepEqual(result.claims[0].draft.data, { VideoType: 'VideoFile', IsShortcut: true });
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('disc Episode placeholders keep their physical parent and source type without requiring a Season', async () => {
  const nested = { ...root, Id: '10000000-0000-0000-0000-000000000004', Path: season.Path + '\\Archive' };
  for (const [parent, parents, suffix, videoType] of [
    [root, [], 'dvd.disc', 'Dvd'], [series, [root], 'brrip.DISC', 'BluRay'],
    [season, [series, root], 'unknown.disc', 'VideoFile'], [nested, [season, series, root], 'disc', 'VideoFile']
  ]) {
    const file = candidate(parent.Path + '\\Show.S01E02.' + suffix, 'file');
    const result = await resolve(pipeline(), parent, [file], { collectionContext: { ...collectionContext, parents } });
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, episodeNativeType);
    assert.equal(claim.identityPath, file.identityPath);
    assert.equal(claim.entry.kind, 'file');
    assert.equal(claim.draft.IsFolder, false);
    assert.equal(claim.draft.initialColumns, undefined, 'episode numbering remains a metadata responsibility');
    assert.deepEqual(claim.draft.data, { VideoType: videoType, IsPlaceHolder: true });
    assert.deepEqual(result.withheldPaths, []);
    for (const options of [{ deletionSafe: false }, { collectionContext: { ...collectionContext,
      contentTypeOverrides: [{ path: file.identityPath, collectionType: 'movies' }] } }]) {
      const rejected = await resolve(pipeline(), parent, [file], options);
      assert.deepEqual(rejected.claims, []);
      assert.deepEqual(rejected.withheldPaths, [file.identityPath]);
    }
  }
});

test('ISO Episodes classify their observed image without requiring a Series or Season', async () => {
  const nested = { ...root, Id: '10000000-0000-0000-0000-000000000004', Path: season.Path + '\\Archive' };
  for (const [parent, parents, extension, isoType] of [
    [root, [], 'iso', 'Dvd'], [series, [root], 'IMG', 'BluRay'],
    [season, [series, root], 'iso', null], [nested, [season, series, root], 'img', 'Dvd']
  ]) {
    const file = candidate(parent.Path + '\\Show.S01E02.' + extension, 'file');
    const result = await resolve(pipeline({ classifyIso: async input => {
      assert.equal(input, file); return isoType;
    } }), parent, [file], { collectionContext: { ...collectionContext, parents } });
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, episodeNativeType);
    assert.equal(claim.identityPath, file.identityPath);
    assert.equal(claim.entry.kind, 'file');
    assert.equal(claim.draft.IsFolder, false);
    assert.deepEqual(claim.draft.data, { VideoType: 'Iso', IsoType: isoType });
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('single Episode ISO resolution propagates consistency and configuration failures without file fallback', async () => {
  const file = candidate(season.Path + '\\Show.S01E01.iso', 'file');
  for (const code of ['version-changed', 'cancelled']) {
    const error = new StorageError(code, 'ISO source read failed.');
    await assert.rejects(resolve(pipeline({ classifyIso: async () => { throw error; } }), season, [file]), value => value === error);
  }
  await assert.rejects(resolve(pipeline(), season, [file]), /ISO resolution requires a storage classifier/u);
  const malformed = new Error('Not a UDF image.'), logged = [];
  const result = await resolve(pipeline({ classifyIso: async () => { throw malformed; },
    logger: { error: (...args) => logged.push(args) } }), season, [file]);
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, episodeNativeType);
  assert.deepEqual(result.claims[0].draft.data, { VideoType: 'Iso', IsoType: null });
  assert.deepEqual(result.withheldPaths, []);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], malformed);
});

test('nested TV directories remain physical Folders and their ordinary files resolve as Episodes', async () => {
  const subject = pipeline();
  for (const [parent, parents, name] of [
    [series, [root], 'Show.S01E05'],
    [season, [series, root], 'Show.S01E05'],
    [season, [series, root], 'Archive']
  ]) {
    const directory = candidate(parent.Path + '\\' + name);
    const file = candidate(directory.identityPath + '\\video.mkv', 'file');
    const result = await resolve(subject, parent, [directory], {
      collectionContext: { ...collectionContext, parents }, peekDirectory: async () => snapshot([file])
    });
    assert.deepEqual(result.withheldPaths, []);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, root.NativeType);
    assert.equal(result.claims[0].traversal, 'children');
    assert.equal(result.claims[0].identityPath, directory.identityPath);
    const folder = { Id: result.claims[0].Id, Path: directory.identityPath, NativeType: root.NativeType };
    const nestedContext = { ...collectionContext, parents: [parent, ...parents] };
    const episodes = await resolve(subject, folder, [file], { collectionContext: nestedContext });
    assert.equal(episodes.claims[0].nativeType, episodeNativeType);
    assert.equal(episodes.claims[0].identityPath, file.identityPath);
    assert.equal(episodes.claims[0].draft.initialColumns, undefined,
      'the existing metadata lifecycle resolves numbering from the file or physical Folder');

    const deeper = candidate(directory.identityPath + '\\More');
    const descendants = await resolve(subject, folder, [deeper], { collectionContext: nestedContext });
    assert.equal(descendants.claims[0].nativeType, root.NativeType, 'TV ancestors do not create a nested Series or Season');
  }
});

for (const videoType of ['Dvd', 'BluRay']) test(`a single ${videoType} directory resolves as an Episode under its physical TV parent`, async () => {
  const nested = { ...root, Id: '10000000-0000-0000-0000-000000000004', Path: season.Path + '\\Archive' };
  for (const [parent, parents] of [[series, [root]], [season, [series, root]], [nested, [season, series, root]]]) {
    const directory = candidate(parent.Path + '\\Show S01E03 3d hsbs');
    const videoTs = candidate(directory.identityPath + (videoType === 'Dvd' ? '\\vIdEo_tS' : '\\bDmV'));
    const vob = candidate(videoTs.identityPath + '\\VTS_01_1.VOB', 'file');
    const result = await resolve(pipeline(), parent, [directory], {
      collectionContext: { ...collectionContext, parents },
      peekDirectory: async (value, options) => {
        if (value === directory) return snapshot([videoTs]);
        assert.equal(videoType, 'Dvd');
        assert.equal(value, videoTs);
        assert.equal(options?.forExtras, true, 'DVD detection uses the raw direct-file observation');
        return snapshot([vob]);
      }
    });
    assert.deepEqual(result.withheldPaths, []);
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, episodeNativeType);
    assert.equal(claim.identityPath, directory.identityPath);
    assert.equal(claim.entry.kind, 'directory');
    assert.equal(claim.traversal, 'none');
    assert.equal(claim.draft.IsFolder, false);
    assert.equal(claim.draft.Name, directory.entry.name);
    assert.equal(claim.draft.initialColumns, undefined, 'metadata and the real parent chain provide episode numbering');
    assert.deepEqual(claim.draft.data, { VideoType: videoType, Video3DFormat: 'HalfSideBySide' });
  }
});

test('disc Episode detection requires strong direct structure evidence', async () => {
  const directory = candidate(season.Path + '\\Show S01E03');
  const videoTs = candidate(directory.identityPath + '\\VIDEO_TS');
  const vob = candidate(videoTs.identityPath + '\\VTS_01_1.VOB', 'file');
  for (const [contents, strong] of [
    [[], true], [[vob], false],
    [[candidate(videoTs.identityPath + '\\Nested\\VTS_01_1.VOB', 'file')], true]
  ]) {
    const result = await resolve(pipeline(), season, [directory], {
      peekDirectory: async value => value === directory ? snapshot([videoTs]) : snapshot(contents, strong)
    });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  }
  const bluray = candidate(directory.identityPath + '\\Nested\\BDMV');
  const result = await resolve(pipeline(), season, [directory], { peekDirectory: async () => snapshot([bluray]) });
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.withheldPaths, [directory.identityPath]);
});

test('nested Folder traversal preserves weak, extra and disc ownership boundaries', async () => {
  const subject = pipeline();
  const directory = candidate(season.Path + '\\Show.S01E05');
  for (const [value, contents, strong] of [
    [directory, [], false],
    [candidate(season.Path + '\\extras'), [], true],
    [candidate(season.Path + '\\BDMV'), [], true],
    [directory, [candidate(directory.identityPath + '\\VIDEO_TS')], true],
    [directory, [candidate(directory.identityPath + '\\BDMV')], false],
    [directory, [candidate(directory.identityPath + '\\VIDEO_TS.IFO', 'file')], true]
  ]) {
    const result = await resolve(subject, season, [value], { peekDirectory: async requested => {
      if (requested === value) return snapshot(contents, strong);
      assert.ok(contents.includes(requested), 'only the observed child directory may be inspected');
      return snapshot([], strong);
    } });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [value.identityPath]);
  }
  const folder = { ...root, Id: '10000000-0000-0000-0000-000000000004', Path: directory.identityPath };
  const nestedContext = { ...collectionContext, parents: [season, series, root] };
  for (const name of ['clip.trailer.mkv', 'clip.trailer.strm', 'clip.trailer.iso']) {
    const file = candidate(folder.Path + '\\' + name, 'file');
    const result = await resolve(subject, folder, [file], { collectionContext: nestedContext });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, [file.identityPath]);
  }
  const file = candidate(folder.Path + '\\episode.mkv', 'file');
  for (const extra of [
    { deletionSafe: false, collectionContext: nestedContext },
    { collectionContext: { ...nestedContext, collectionType: 'movies' } },
    { collectionContext: { ...nestedContext, contentTypeOverrides: [{ path: file.identityPath, collectionType: 'movies' }] } }
  ]) {
    const result = await resolve(subject, folder, [file], extra);
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [file.identityPath]);
  }
});

test('weak observations, overrides and physical TV BluRay directories remain withheld', async () => {
  const subject = pipeline(), directory = candidate(series.Path);
  for (const extra of [
    { deletionSafe: false }, { peekDirectory: async () => snapshot([], false) },
    { collectionContext: { ...collectionContext, contentTypeOverrides: [{ path: directory.identityPath, collectionType: 'movies' }] } }
  ]) {
    const result = await resolve(subject, root, [directory], extra);
    assert.deepEqual(result.claims, []); assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  }
  for (const name of ['Show.S01E01.iso', 'Show.S01E01.img']) {
    const file = candidate(season.Path + '\\' + name, 'file');
    for (const extra of [{ deletionSafe: false }, { collectionContext: { ...collectionContext,
      contentTypeOverrides: [{ path: file.identityPath, collectionType: 'movies' }] } }]) {
      const result = await resolve(subject, season, [file], extra);
      assert.deepEqual(result.claims, []); assert.deepEqual(result.withheldPaths, [file.identityPath]);
    }
  }
  const extras = candidate(series.Path + '\\extras');
  const specialSeason = await resolve(subject, series, [extras]);
  assert.equal(specialSeason.claims.length, 1);
  assert.equal(specialSeason.claims[0].nativeType, seasonNativeType);
  assert.equal(specialSeason.claims[0].draft.initialColumns.IndexNumber, 0,
    'the native special-season names include extras directly under a Series');
  assert.deepEqual(specialSeason.withheldPaths, []);
  const disc = candidate(series.Path + '\\BDMV');
  const result = await resolve(subject, series, [disc]);
  assert.deepEqual(result.claims, []); assert.deepEqual(result.withheldPaths, [disc.identityPath]);
});

test('TV extras decline single-file fallback without creating another video type', async () => {
  const subject = new DirectoryItemResolverPipeline({
    resolvers: [createTvItemResolver(), createVideoFileResolver()], programDataPath: 'C:\\ProgramData\\MediaManager'
  });
  const episodes = ['Show.S01E01.mkv', 'Show.S01E02.mkv'].map(name => candidate(season.Path + '\\' + name, 'file'));
  const extras = ['Show.S01E01.trailer.mkv', 'Show.S01E02.trailer.strm'].map(name => candidate(season.Path + '\\' + name, 'file'));
  const result = await resolve(subject, season, [...episodes, ...extras]);
  assert.deepEqual(result.claims.map(claim => claim.identityPath), episodes.map(value => value.identityPath));
  assert.ok(result.claims.every(claim => claim.nativeType === episodeNativeType
    && claim.ownsOwnedExtras === false && claim.ownedExtras.length === 0));
  assert.deepEqual(result.withheldPaths, []);
  assert.deepEqual(result.unclaimedPaths, extras.map(value => value.identityPath));

  const weak = await resolve(subject, season, extras, { deletionSafe: false });
  assert.deepEqual(weak.claims, []);
  assert.deepEqual(weak.withheldPaths, extras.map(value => value.identityPath));
});

test('TV path provider identifiers use each native resolver leaf and provider set', () => {
  const attributes = '[imdbid=tt1234567] [tvdbid=123] [tvmazeid=45] [tmdbid=67] [anidbid=89] [anilistid=90] [anisearchid=91]';
  for (const type of ['Series', 'Season', 'Episode']) {
    const item = { Type: type, Path: `Z:\\TV\\[tmdbid=999]\\${type} ${attributes}${type === 'Episode' ? '.mkv' : ''}` };
    setResolverProviderIdsFromPath(item);
    assert.deepEqual(item.ProviderIds, { Tvdb: '123', TvMaze: '45', Tmdb: '67',
      ...(type === 'Season' ? {} : { Imdb: 'tt1234567' }),
      ...(type === 'Episode' ? {} : { AniDB: '89', AniList: '90', AniSearch: '91' }) });
  }
});
