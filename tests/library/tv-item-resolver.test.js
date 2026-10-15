import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import {
  createTvItemResolver,
  episodeNativeType,
  seasonNativeType,
  seriesNativeType
} from '../../src/library/tv-item-resolver.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const root = {
  Id: '10000000-0000-0000-0000-000000000001',
  Path: 'Z:\\TV',
  Type: 'MediaBrowser.Controller.Entities.Folder',
  NativeType: 'MediaBrowser.Controller.Entities.Folder',
  IsFolder: true
};
const collectionContext = Object.freeze({
  collectionType: 'tvshows',
  collectionTypeSource: 'collection-folder',
  collections: Object.freeze([{ collectionType: 'tvshows' }]),
  contentTypeOverrides: Object.freeze([])
});

function candidate(identityPath, kind = 'directory') {
  const name = identityPath.split('\\').at(-1);
  return { identityPath, accessPath: identityPath.replace('Z:\\TV', '/tv').replaceAll('\\', '/'),
    entry: { kind, name, size: kind === 'file' ? 5 : undefined } };
}

function pipeline() {
  return new DirectoryItemResolverPipeline({ resolvers: [createTvItemResolver()], programDataPath });
}

function snapshot(children, deletionSafe = true) {
  return { candidates: children, listing: { deletionSafe, entries: children.map(child => child.entry) } };
}

test('conventional TV hierarchy claims Series, Season and one Episode with create-only numbering', async () => {
  const subject = pipeline();
  assert.deepEqual(subject.capabilities, {
    resolvesProductionMediaFiles: true,
    productionMediaScopes: ['conventional-tv-series-season-single-episodes']
  });

  const series = candidate('Z:\\TV\\Example Show (2024)');
  const season = candidate('Z:\\TV\\Example Show (2024)\\Season 01');
  const episode = candidate('Z:\\TV\\Example Show (2024)\\Season 01\\Example.Show.S01E02.mkv', 'file');
  const seriesResult = await subject.resolve({
    parent: root,
    root,
    collectionContext,
    candidates: [series],
    peekDirectory: async () => snapshot([season])
  });
  assert.equal(seriesResult.claims.length, 1);
  assert.equal(seriesResult.claims[0].nativeType, seriesNativeType);
  assert.equal(seriesResult.claims[0].draft.Name, 'Example Show');
  assert.deepEqual(seriesResult.claims[0].draft.initialColumns, { ProductionYear: 2024 });
  assert.equal(seriesResult.claims[0].traversal, 'children');

  const seriesParent = {
    Id: seriesResult.claims[0].Id,
    Path: series.identityPath,
    NativeType: seriesNativeType,
    Type: 'Series',
    IsFolder: true,
    TopParentId: root.Id
  };
  const seasonResult = await subject.resolve({
    parent: seriesParent,
    root,
    collectionContext,
    candidates: [season],
    peekDirectory: async () => snapshot([episode])
  });
  assert.equal(seasonResult.claims[0].nativeType, seasonNativeType);
  assert.deepEqual(seasonResult.claims[0].draft.initialColumns, { IndexNumber: 1 });

  const seasonParent = {
    Id: seasonResult.claims[0].Id,
    Path: season.identityPath,
    NativeType: seasonNativeType,
    Type: 'Season',
    IsFolder: true,
    TopParentId: root.Id,
    SeriesId: seriesParent.Id,
    IndexNumber: 1
  };
  const episodeResult = await subject.resolve({
    parent: seasonParent,
    root,
    collectionContext,
    candidates: [episode]
  });
  assert.equal(episodeResult.claims[0].nativeType, episodeNativeType);
  assert.equal(episodeResult.claims[0].draft.Name, 'Example.Show.S01E02');
  assert.deepEqual(episodeResult.claims[0].draft.initialColumns, {
    IndexNumber: 2,
    ParentIndexNumber: 1
  });
  assert.deepEqual(episodeResult.claims[0].draft.data, { VideoType: 'VideoFile' });
});

test('selected native TV type resolves series while weak snapshots and non-TV child overrides are withheld', async () => {
  const subject = pipeline(), series = candidate('Z:\\TV\\Series'), season = candidate(series.identityPath + '\\Season 1');
  const ordered = { ...collectionContext, collections: [{ collectionType: 'tvshows' }, { collectionType: 'movies' }] };
  const result = await subject.resolve({ parent: root, root, collectionContext: ordered, candidates: [series], peekDirectory: async () => snapshot([season]) });
  assert.equal(result.claims[0].nativeType, seriesNativeType);
  for (const options of [
    { deletionSafe: false },
    { collectionContext: { ...ordered, contentTypeOverrides: [{ path: series.identityPath, collectionType: 'movies' }] } },
    { peekDirectory: async () => snapshot([season], false) },
    { peekDirectory: async () => snapshot([candidate(series.identityPath + '\\Specials')]) }
  ]) {
    const withheld = await subject.resolve({ parent: root, root, collectionContext: ordered, candidates: [series],
      peekDirectory: async () => snapshot([season]), ...options });
    assert.deepEqual(withheld.claims, []); assert.deepEqual(withheld.withheldPaths, [series.identityPath]);
  }
  const exact = await subject.resolve({ parent: root, root,
    collectionContext: { ...ordered, collectionType: 'movies', contentTypeOverrides: [{ path: series.identityPath, collectionType: 'tvshows' }] },
    candidates: [series], peekDirectory: async () => snapshot([season]) });
  assert.equal(exact.claims[0].nativeType, seriesNativeType);
});

test('unproved season and episode branches fail closed instead of becoming folders or videos', async t => {
  const subject = pipeline();
  const seriesParent = {
    Id: '10000000-0000-0000-0000-000000000002',
    Path: 'Z:\\TV\\Example Show',
    NativeType: seriesNativeType,
    Type: 'Series',
    IsFolder: true,
    TopParentId: root.Id
  };
  const seasonParent = {
    Id: '10000000-0000-0000-0000-000000000003',
    Path: 'Z:\\TV\\Example Show\\Season 1',
    NativeType: seasonNativeType,
    Type: 'Season',
    IsFolder: true,
    TopParentId: root.Id,
    SeriesId: seriesParent.Id,
    IndexNumber: 1
  };

  for (const name of ['Specials', 'Extras', 'Season 0', 'Season 200', 'S01', '1']) await t.test(name, async () => {
    const directory = candidate(`${seriesParent.Path}\\${name}`);
    const result = await subject.resolve({ parent: seriesParent, root, collectionContext, candidates: [directory],
      peekDirectory: async () => snapshot([]) });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });

  for (const name of [
    'Show.S02E01.mkv',
    'Show.S01E01-E02.mkv',
    'Show.S01E01.S01E02.mkv',
    'Show.S01E01.trailer.mkv',
    'Show.1080p.S01E01.mkv',
    'Show.S01E01.disc',
    'Show.S01E01.iso',
    'Show.2026-01-02.mkv'
  ]) await t.test(name, async () => {
    const file = candidate(`${seasonParent.Path}\\${name}`, 'file');
    const result = await subject.resolve({ parent: seasonParent, root, collectionContext, candidates: [file] });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [file.identityPath]);
  });

  const first = candidate(`${seasonParent.Path}\\Show.S01E01.mkv`, 'file');
  const alternate = candidate(`${seasonParent.Path}\\Alternate.S01E01.mp4`, 'file');
  const duplicate = await subject.resolve({
    parent: seasonParent,
    root,
    collectionContext,
    candidates: [first, alternate]
  });
  assert.deepEqual(duplicate.claims, []);
  assert.deepEqual(new Set(duplicate.withheldPaths), new Set([first.identityPath, alternate.identityPath]));

  const version = candidate(`${seasonParent.Path}\\Show.S01E01-1080p.mkv`, 'file');
  const versioned = await subject.resolve({
    parent: seasonParent,
    root,
    collectionContext,
    candidates: [first, version]
  });
  assert.deepEqual(versioned.claims, []);
  assert.deepEqual(new Set(versioned.withheldPaths), new Set([first.identityPath, version.identityPath]));
});
