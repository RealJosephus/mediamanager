import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import {
  createVideoFileResolver,
  isNativeVideoFileName,
  resolveOrdinaryVideoFile,
  resolveVideoSourceFields,
  movieNativeType,
  musicVideoNativeType,
  trailerNativeType,
  videoNativeType
} from '../../src/library/video-file-resolver.js';
import { audioNativeType } from '../../src/library/audio-item-resolver.js';
import { StorageError } from '../../src/storage/errors.js';
import { createTvItemResolver, episodeNativeType, seasonNativeType, seriesNativeType } from '../../src/library/tv-item-resolver.js';

const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Media';
const root = Object.freeze({ Id: '00000000-0000-0000-0000-000000000001', Path: rootPath });

function candidate(name, { directory = rootPath, kind = 'file' } = {}) {
  return {
    identityPath: `${directory}\\${name}`,
    accessPath: path.posix.join('/media', path.win32.relative(rootPath, directory).replaceAll('\\', '/'), name.replaceAll('\\', '/')),
    entry: { kind, name }
  };
}

function collectionContext(collectionType, overrides = {}) {
  return Object.freeze({
    collectionType,
    collectionTypeSource: 'collection-folder',
    ...overrides
  });
}

function pipeline(options) {
  return new DirectoryItemResolverPipeline({
    resolvers: [createVideoFileResolver(options)],
    programDataPath
  });
}

function tvPipeline(options) {
  return new DirectoryItemResolverPipeline({ resolvers: [createTvItemResolver(options), createVideoFileResolver(options)], programDataPath });
}

function nestedParent(path) {
  return Object.freeze({ Id: `parent:${path}`, Path: path });
}

function directorySnapshot(candidates, deletionSafe = true) {
  return { listing: { deletionSafe }, candidates };
}

async function resolve(candidates, {
  parent = root,
  context = collectionContext('homevideos'),
  peekDirectory, classifyIso, logger
} = {}) {
  return pipeline({ classifyIso, logger }).resolve({ parent, root, collectionContext: context, candidates, peekDirectory });
}

test('explicit movies parse metadata names and preserve production year as a create-only column', async () => {
  const file = candidate('The Film (2020).MKV');
  const result = await resolve([file], { context: collectionContext('movies') });

  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.equal(claim.resolverId, 'builtin-video-files');
  assert.equal(claim.nativeType, movieNativeType);
  assert.equal(claim.identityPath, file.identityPath);
  assert.deepEqual(claim.consumedPaths, [file.identityPath]);
  assert.equal(claim.traversal, 'none');
  assert.deepEqual(claim.draft, {
    Name: 'The Film',
    IsFolder: false,
    MediaType: 'Video',
    SourceType: 'Library',
    columns: { IsInMixedFolder: true },
    initialColumns: { ProductionYear: 2020 },
    data: { VideoType: 'VideoFile', LocalAlternateVersions: [] }
  });
  assert.deepEqual(result.unclaimedPaths, []);
});

test('explicit home videos retain the raw filename stem and derive mixed-folder state from their parent', async t => {
  await t.test('physical-root file is mixed even when it is the only video', async () => {
    const file = candidate('Family (2021).mp4');
    const result = await resolve([file]);
    const [claim] = result.claims;

    assert.equal(claim.nativeType, videoNativeType);
    assert.equal(claim.draft.Name, 'Family (2021)');
    assert.equal(claim.draft.columns.IsInMixedFolder, true);
    assert.equal(Object.hasOwn(claim.draft, 'initialColumns'), false,
      'home-video names are not parsed into a create-time production year');
    assert.deepEqual(claim.draft.data, { VideoType: 'VideoFile', LocalAlternateVersions: [] });
  });

  await t.test('one video in a nested folder is not mixed', async () => {
    const path = `${rootPath}\\Family`;
    const file = candidate('clip.webm', { directory: path });
    const result = await resolve([file], { parent: nestedParent(path) });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, videoNativeType);
    assert.equal(result.claims[0].draft.columns.IsInMixedFolder, false);
  });

  await t.test('multiple ordinary videos in a nested folder are mixed', async () => {
    const path = `${rootPath}\\Family`;
    const files = [candidate('one.mp4', { directory: path }), candidate('two.mkv', { directory: path })];
    const result = await resolve(files, { parent: nestedParent(path) });

    assert.equal(result.claims.length, 2);
    assert.deepEqual(result.claims.map(claim => claim.draft.columns.IsInMixedFolder), [true, true]);
  });
});

test('ordinary movie files resolve below a generic nested Folder', async () => {
  const path = `${rootPath}\\The Film (2020)`;
  const file = candidate('The Film (2020).mkv', { directory: path });
  const result = await resolve([file], {
    parent: nestedParent(path),
    context: collectionContext('movies')
  });

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, movieNativeType);
  assert.equal(result.claims[0].draft.Name, 'The Film (2020)',
    'a qualifying movie version uses the containing folder name even when it is the only version');
  assert.equal(result.claims[0].draft.columns.IsInMixedFolder, false);
  assert.deepEqual(result.unclaimedPaths, []);
});

test('photos libraries admit video files without merging editions or collapsing directories', async () => {
  const directory = candidate('Family', { kind: 'directory' });
  const files = ['Family - 1080p.mp4', 'Family - 720p.mp4', 'sunset.jpg']
    .map(name => candidate(name, { directory: directory.identityPath }));
  const context = collectionContext('photos');
  const result = await resolve(files, { parent: nestedParent(directory.identityPath), context });
  assert.deepEqual(result.claims.map(value => value.identityPath), files.slice(0, 2).map(value => value.identityPath));
  for (const claim of result.claims) {
    assert.equal(claim.nativeType, videoNativeType);
    assert.equal(claim.draft.Name, path.win32.basename(claim.identityPath, '.mp4'));
    assert.equal(claim.draft.columns.IsInMixedFolder, true);
    assert.deepEqual(claim.draft.data.LocalAlternateVersions, []);
  }
  assert.deepEqual(result.unclaimedPaths, [files[2].identityPath]);
  assert.deepEqual(result.withheldPaths, []);

  const folders = await resolve([directory], { context, peekDirectory: async () => directorySnapshot(files.slice(0, 1)) });
  assert.equal(folders.claims[0].nativeType, folderNativeType);
  assert.equal(folders.claims[0].identityPath, directory.identityPath);
  assert.equal(folders.claims[0].traversal, 'children');
  const dvd = candidate('DVD', { kind: 'directory' });
  const videoTs = candidate('VIDEO_TS', { directory: dvd.identityPath, kind: 'directory' });
  const disc = await resolve([dvd], { context, peekDirectory: async value => directorySnapshot(value === dvd
    ? [videoTs] : [candidate('VTS_01_1.VOB', { directory: videoTs.identityPath })]) });
  assert.equal(disc.claims[0].nativeType, folderNativeType, 'photos do not use the movie directory resolver');
});

test('a top-level directory whose name is also an extras convention remains a movie candidate', async () => {
  const directory = candidate('trailers', { kind: 'directory' });
  const movie = candidate('Feature.mkv', { directory: directory.identityPath });
  const result = await resolve([directory], {
    context: collectionContext('movies'),
    peekDirectory: async current => {
      assert.equal(current, directory);
      return directorySnapshot([movie]);
    }
  });

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, movieNativeType);
  assert.equal(result.claims[0].identityPath, movie.identityPath);
  assert.equal(result.claims[0].draft.Name, 'trailers');
  assert.deepEqual(result.withheldPaths, []);
});

test('ordinary movie directories collapse or fall back while unsupported shapes stay fail closed', async t => {
  const context = collectionContext('movies');
  await t.test('missing peek capability is withheld', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const result = await resolve([directory], { context });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });

  await t.test('a strong direct-file snapshot resolves direct extras and authoritatively peeks typed extra folders', async () => {
    const directory = candidate('The Film (2020)', { kind: 'directory' });
    const movie = candidate('feature (2021).mkv', { directory: directory.identityPath });
    const metadata = candidate('movie.nfo', { directory: directory.identityPath });
    const trailer = candidate('The Film (2020)-trailer.mkv', { directory: directory.identityPath });
    const trailersFolder = candidate('trailers', { directory: directory.identityPath, kind: 'directory' });
    const extrasFolder = candidate('EXTRAS', { directory: directory.identityPath, kind: 'directory' });
    const peeked = [];
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        peeked.push(current);
        if (current === directory) return directorySnapshot([movie, metadata, trailer, trailersFolder, extrasFolder]);
        assert.ok([trailersFolder, extrasFolder].includes(current));
        return directorySnapshot([]);
      }
    });

    assert.deepEqual(peeked, [directory, trailersFolder, extrasFolder]);
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.resolverId, 'builtin-video-files');
    assert.equal(claim.nativeType, movieNativeType);
    assert.equal(claim.identityPath, movie.identityPath);
    assert.equal(claim.accessPath, movie.accessPath);
    assert.equal(claim.entry, movie.entry);
    assert.equal(claim.primary, directory);
    assert.deepEqual(claim.consumedPaths, [directory.identityPath, movie.identityPath]);
    assert.deepEqual(claim.replacementPaths, [directory.identityPath]);
    assert.equal(claim.traversal, 'none');
    assert.deepEqual(claim.draft, {
      Name: 'The Film (2020)',
      IsFolder: false,
      MediaType: 'Video',
      SourceType: 'Library',
      columns: { IsInMixedFolder: false },
      initialColumns: { ProductionYear: 2021 },
      data: { VideoType: 'VideoFile', LocalAlternateVersions: [] }
    });
    assert.equal(claim.ownsOwnedExtras, true);
    assert.equal(claim.ownedExtrasDeletionSafe, true);
    assert.equal(claim.ownedExtras.length, 1);
    assert.equal(claim.ownedExtras[0].identityPath, trailer.identityPath);
    assert.equal(claim.ownedExtras[0].nativeType, trailerNativeType);
    assert.equal(claim.ownedExtras[0].extraType, 2);
    assert.equal(claim.ownedExtras[0].ownerId, claim.Id);
    assert.equal(claim.ownedExtras[0].draft.Name, 'The Film');
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  for (const [name, children] of [
    ['disc image', [candidate('The Film.iso', { directory: `${rootPath}\\The Film` })]]
  ]) await t.test(name, async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const result = await resolve([directory], {
      context,
      classifyIso: async () => 'Dvd',
      peekDirectory: async current => {
        assert.equal(current, directory);
        return directorySnapshot(children);
      }
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].identityPath, children[0].identityPath);
    assert.equal(result.claims[0].draft.data.VideoType, 'Iso');
    assert.equal(result.claims[0].draft.data.IsoType, 'Dvd');
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  for (const [collectionType, nativeType] of [
    ['movies', movieNativeType],
    ['musicvideos', musicVideoNativeType],
    ['homevideos', videoNativeType]
  ]) for (const [name, videoType, children, nestedChildren] of [
    ['VIDEO_TS with a direct VOB', 'Dvd', ['VIDEO_TS'], ['VTS_01_1.VOB', 'VIDEO_TS.BUP']],
    ['BDMV', 'BluRay', ['BDMV'], null],
    ['direct video_ts.ifo', 'Dvd', ['video_ts.ifo'], null]
  ]) await t.test(`${collectionType} ${name}`, async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const direct = children.map(child => candidate(child, { directory: directory.identityPath,
      kind: child.toLowerCase() === 'bdmv' || child.toLowerCase() === 'video_ts' ? 'directory' : 'file' }));
    const nested = nestedChildren?.map(child => candidate(child, { directory: direct[0].identityPath }));
    const peeked = [];
    const result = await resolve([directory], {
      context: collectionContext(collectionType),
      peekDirectory: async (current, options) => {
        peeked.push([current, options]);
        if (current === directory) return directorySnapshot(direct);
        assert.equal(current, direct[0]);
        assert.deepEqual(options, { forExtras: true });
        return directorySnapshot(nested);
      }
    });

    assert.deepEqual(peeked, nested == null ? [[directory, undefined]]
      : [[directory, undefined], [direct[0], { forExtras: true }]]);
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, nativeType);
    assert.equal(claim.identityPath, directory.identityPath);
    assert.equal(claim.accessPath, directory.accessPath);
    assert.equal(claim.entry, directory.entry);
    assert.equal(claim.primary, directory);
    assert.deepEqual(claim.consumedPaths, [directory.identityPath]);
    assert.deepEqual(claim.replacementPaths, []);
    assert.equal(claim.traversal, 'none');
    assert.deepEqual(claim.draft, {
      IsFolder: false,
      MediaType: 'Video',
      SourceType: 'Library',
      columns: { IsInMixedFolder: false },
      data: { VideoType: videoType, LocalAlternateVersions: [] }
    });
    assert.equal(claim.ownsLocalAlternates, false);
    assert.deepEqual(claim.localAlternates, []);
    assert.equal(claim.ownsOwnedParts, false);
    assert.deepEqual(claim.ownedParts, []);
    assert.equal(claim.ownsOwnedExtras, false);
    assert.deepEqual(claim.ownedExtras, []);
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  await t.test('disc 3D format is parsed from the outer identity path', async () => {
    const directory = candidate('The Film.3d.hsbs', { kind: 'directory' });
    const bdmv = candidate('BDMV', { directory: directory.identityPath, kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async () => directorySnapshot([bdmv])
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].identityPath, directory.identityPath);
    assert.equal(result.claims[0].draft.data.Video3DFormat, 'HalfSideBySide');
    assert.equal(Object.hasOwn(result.claims[0].draft, 'initialColumns'), false,
      'disc directory names do not produce a create-time ProductionYear');
  });

  await t.test('VIDEO_TS without a direct VOB remains an ordinary traversable Folder', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const videoTs = candidate('VIDEO_TS', { directory: directory.identityPath, kind: 'directory' });
    const nested = candidate('VIDEO_TS.IFO', { directory: videoTs.identityPath });
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => current === directory
        ? directorySnapshot([videoTs])
        : directorySnapshot([nested])
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, folderNativeType);
    assert.deepEqual(result.withheldPaths, []);
  });

  for (const mode of ['weak', 'malformed']) {
    await t.test(`a ${mode} VIDEO_TS observation is withheld`, async () => {
      const directory = candidate('The Film', { kind: 'directory' });
      const videoTs = candidate('VIDEO_TS', { directory: directory.identityPath, kind: 'directory' });
      const vob = candidate('VTS_01_1.VOB', { directory: videoTs.identityPath });
      const nested = mode === 'weak' ? directorySnapshot([vob], false) : { listing: { deletionSafe: true } };
      const result = await resolve([directory], {
        context,
        peekDirectory: async current => current === directory ? directorySnapshot([videoTs]) : nested
      });

      assert.deepEqual(result.claims, []);
      assert.deepEqual(result.withheldPaths, [directory.identityPath]);
    });
  }

  await t.test('a malformed direct disc marker cannot authorize the outer identity', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const escapedBdmv = candidate('BDMV', { directory: `${rootPath}\\Another Film`, kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async () => directorySnapshot([escapedBdmv])
    });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });

  await t.test('a failed VIDEO_TS observation recovers through the native Folder fallback', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const videoTs = candidate('VIDEO_TS', { directory: directory.identityPath, kind: 'directory' });
    const failure = Object.assign(new Error('controlled VIDEO_TS observation failure'), { code: 'io' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        if (current === directory) return directorySnapshot([videoTs]);
        throw failure;
      }
    });
    assert.deepEqual(result.claims.map(claim => [claim.nativeType, claim.identityPath]), [[folderNativeType, directory.identityPath]]);
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('a direct ordinary movie plus a non-extra subdirectory does not partially collapse', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const movie = candidate('The Film.mkv', { directory: directory.identityPath });
    const bonus = candidate('Bonus', { directory: directory.identityPath, kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        assert.equal(current, directory);
        return directorySnapshot([movie, bonus]);
      }
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].nativeType, folderNativeType);
    assert.equal(result.claims[0].traversal, 'children');
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('independent videos fall back to a traversable Folder', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const files = [candidate('The Film.mkv', { directory: directory.identityPath }),
      candidate('Another Film.mp4', { directory: directory.identityPath })];
    const result = await resolve([directory], { context, peekDirectory: async () => directorySnapshot(files) });
    assert.equal(result.claims[0].nativeType, folderNativeType);
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('a nested file stack retains all consumed members and its additional part', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const files = [candidate('The Film cd1.mkv', { directory: directory.identityPath }),
      candidate('The Film cd2.mkv', { directory: directory.identityPath })];
    const result = await resolve([directory], { context, peekDirectory: async () => directorySnapshot(files) });
    assert.equal(result.claims[0].nativeType, movieNativeType);
    assert.equal(result.claims[0].identityPath, files[0].identityPath);
    assert.deepEqual(result.claims[0].consumedPaths, [directory, ...files].map(value => value.identityPath));
    assert.deepEqual(result.claims[0].draft.data.AdditionalParts, [files[1].identityPath]);
    assert.deepEqual(result.claims[0].ownedParts.map(value => value.identityPath), [files[1].identityPath]);
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('metadata-only directory', async () => {
    const directory = candidate('Collections', { kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async () => directorySnapshot([
        candidate('folder.nfo', { directory: directory.identityPath })
      ])
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].resolverId, 'folder-fallback');
    assert.equal(result.claims[0].nativeType, folderNativeType);
    assert.deepEqual(result.withheldPaths, []);
  });

  for (const [stackName, childName, childKind, expectedPeekNames] of [
    ['Disc 1', 'The Film.mkv', 'file', ['The Film', 'Disc 1']],
    ['CD2', 'VIDEO_TS', 'directory', ['The Film', 'CD2', 'VIDEO_TS']],
    ['DVD 1', 'BDMV', 'directory', ['The Film', 'DVD 1']]
  ]) await t.test(`media directly below ${stackName}`, async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const stack = candidate(stackName, { directory: directory.identityPath, kind: 'directory' });
    const child = candidate(childName, { directory: stack.identityPath, kind: childKind });
    const peeked = [];
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        peeked.push(current);
        if (current === directory) return directorySnapshot([stack]);
        if (current === stack) return directorySnapshot([child]);
        assert.equal(current, child);
        return directorySnapshot([]);
      }
    });

    assert.deepEqual(peeked.map(value => value.entry.name), expectedPeekNames);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].resolverId, 'folder-fallback');
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('ordinary child directories are inspected once for native disc structures', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const bonus = candidate('Bonus', { directory: directory.identityPath, kind: 'directory' });
    const peeked = [];
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        peeked.push(current);
        if (current === directory) return directorySnapshot([bonus]);
        assert.equal(current, bonus);
        return directorySnapshot([]);
      }
    });

    assert.deepEqual(peeked, [directory, bonus]);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].resolverId, 'folder-fallback');
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('a stack child is peeked only once and deeper directories are not traversed', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const stack = candidate('Disc 1', { directory: directory.identityPath, kind: 'directory' });
    const deeper = candidate('Content', { directory: stack.identityPath, kind: 'directory' });
    const peeked = [];
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        peeked.push(current);
        if (current === directory) return directorySnapshot([stack]);
        if (current === stack) return directorySnapshot([deeper]);
        assert.fail('directory peeking must stop at the second level');
      }
    });

    assert.deepEqual(peeked, [directory, stack]);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].resolverId, 'folder-fallback');
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('a weak direct peek is withheld instead of creating a Folder', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => {
        assert.equal(current, directory);
        return directorySnapshot([], false);
      }
    });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });

  await t.test('a weak stack-directory peek withholds the owning movie directory', async () => {
    const directory = candidate('The Film', { kind: 'directory' });
    const stack = candidate('Disc 1', { directory: directory.identityPath, kind: 'directory' });
    const result = await resolve([directory], {
      context,
      peekDirectory: async current => current === directory
        ? directorySnapshot([stack])
        : directorySnapshot([], false)
    });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
  });
});

test('ordinary movie alternate versions and file stacks form deterministic native families', async t => {
  const context = collectionContext('movies');
  const versions = [candidate('Media.mkv'), candidate('Media - 1080p.mp4')];
  const groupedResult = await resolve(versions, { context });

  assert.equal(groupedResult.claims.length, 1);
  assert.equal(groupedResult.claims[0].identityPath, versions[0].identityPath);
  assert.deepEqual(groupedResult.claims[0].consumedPaths, versions.map(value => value.identityPath));
  assert.deepEqual(groupedResult.claims[0].draft.data.LocalAlternateVersions, [versions[1].identityPath]);
  assert.deepEqual(groupedResult.claims[0].localAlternates.map(value => value.identityPath), [versions[1].identityPath]);
  assert.deepEqual(groupedResult.withheldPaths, []);
  assert.deepEqual(groupedResult.passedToSingle, []);

  await t.test('a bare stack remains separate from an ordinary version whose folder suffix is eligible', async () => {
    const files = [
      candidate('Media cd1.mkv'),
      candidate('Media cd2.mkv'),
      candidate('Media - 1080p.mp4'),
      candidate('Media-trailer2.mkv')
    ];
    const result = await resolve(files, { context });

    assert.deepEqual(result.claims.map(claim => claim.identityPath), [files[0].identityPath, files[2].identityPath]);
    assert.deepEqual(result.claims[0].draft.data.AdditionalParts, [files[1].identityPath]);
    assert.deepEqual(result.claims[0].ownedParts.map(part => part.identityPath), [files[1].identityPath]);
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, [files[3].identityPath]);
  });

  await t.test('an independent year does not break a valid stack and alternate bucket', async () => {
    const files = [
      candidate('Media (2020) cd1.mkv'),
      candidate('Media (2020) cd2.mkv'),
      candidate('Media (2020) - 1080p.mp4'),
      candidate('Media (2021).mkv'),
      candidate('Other Film.mkv')
    ];
    const result = await resolve(files, { context });

    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(new Set(result.claims.map(value => value.identityPath)),
      new Set([files[0], ...files.slice(2)].map(value => value.identityPath)));
    const stack = result.claims.find(value => value.identityPath === files[0].identityPath);
    assert.deepEqual(stack.draft.data.AdditionalParts, [files[1].identityPath]);
  });

  await t.test('a folder-named primary preserves the parts of its stacked alternate', async () => {
    const files = [
      candidate('Media-featurette cd1.mkv'),
      candidate('Media-featurette cd2.mkv'),
      candidate('Media.mkv')
    ];
    const result = await resolve(files, { context });

    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.claims.map(value => value.identityPath), [files[2].identityPath]);
    assert.deepEqual(result.claims[0].draft.data.LocalAlternateVersions, [files[0].identityPath]);
    const alternate = result.claims[0].localAlternates[0];
    assert.deepEqual(alternate.draft.data.AdditionalParts, [files[1].identityPath]);
    assert.deepEqual(result.claims[0].ownedParts.map(part => [part.identityPath, part.ownerId]),
      [[files[1].identityPath, alternate.Id]]);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  for (const extension of ['iso', 'img']) {
    await t.test(`.${extension} primary keeps its disc type with an ordinary alternate`, async () => {
      const files = [candidate(`Media.${extension}`), candidate('Media - 1080p.mkv')];
      const result = await resolve(files, { context, classifyIso: async () => 'BluRay' });

      assert.equal(result.claims.length, 1);
      assert.equal(result.claims[0].identityPath, files[0].identityPath);
      assert.equal(result.claims[0].draft.data.VideoType, 'Iso');
      assert.equal(result.claims[0].draft.data.IsoType, 'BluRay');
      assert.equal(result.claims[0].localAlternates[0].draft.data.VideoType, 'VideoFile');
      assert.deepEqual(result.withheldPaths, []);
    });
  }

  await t.test('STRM files retain shortcut identity as either the primary or an alternate', async () => {
    for (const [primaryExtension, alternateExtension] of [['strm', 'mkv'], ['mkv', 'STRM']]) {
      const files = [candidate(`Media.${primaryExtension}`), candidate(`Media - 1080p.${alternateExtension}`)];
      const result = await resolve(files, { context });
      assert.equal(result.claims.length, 1);
      const [claim] = result.claims;
      assert.equal(claim.identityPath, files[0].identityPath);
      assert.equal(claim.draft.data.VideoType, 'VideoFile');
      assert.equal(claim.draft.data.IsShortcut === true, primaryExtension === 'strm');
      assert.deepEqual(claim.draft.data.LocalAlternateVersions, [files[1].identityPath]);
      assert.equal(claim.localAlternates[0].draft.data.IsShortcut === true, alternateExtension === 'STRM');
      assert.equal(resolveOrdinaryVideoFile(files[alternateExtension === 'STRM' ? 1 : 0]).IsShortcut, true);
      assert.deepEqual(result.withheldPaths, []);
    }
  });

  await t.test('disc placeholders retain their own type as either the primary or an alternate', async () => {
    for (const [primarySuffix, alternateSuffix] of [['disc', 'mkv'], ['mkv', 'bd50.DISC']]) {
      const files = [candidate(`Media.${primarySuffix}`), candidate(`Media - 1080p.${alternateSuffix}`)];
      const result = await resolve(files, { context });
      assert.equal(result.claims.length, 1);
      const [claim] = result.claims;
      assert.equal(claim.identityPath, files[0].identityPath);
      assert.equal(claim.draft.data.IsPlaceHolder === true, primarySuffix === 'disc');
      assert.equal(claim.draft.data.VideoType, 'VideoFile');
      assert.deepEqual(claim.draft.data.LocalAlternateVersions, [files[1].identityPath]);
      assert.equal(claim.localAlternates[0].draft.data.IsPlaceHolder === true, alternateSuffix === 'bd50.DISC');
      assert.equal(claim.localAlternates[0].draft.data.VideoType, alternateSuffix === 'bd50.DISC' ? 'BluRay' : 'VideoFile');
      assert.deepEqual(result.withheldPaths, []);
    }
  });

  await t.test('stack parts alone remain one logical version rather than an alternate group', async () => {
    const files = [candidate('Media cd1.mkv'), candidate('Media cd2.mkv')];
    const result = await resolve(files, { context });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].identityPath, files[0].identityPath);
    assert.deepEqual(result.claims[0].draft.data.AdditionalParts, [files[1].identityPath]);
    assert.deepEqual(result.claims[0].ownedParts.map(value => value.identityPath), [files[1].identityPath]);
    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  await t.test('different parsed years are independent movies', async () => {
    const files = [candidate('Media (2020).mkv'), candidate('Media - Cut (2021).mp4')];
    const result = await resolve(files, { context });
    assert.equal(result.claims.length, 2);
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('an illegal prefix continuation is not an alternate group', async () => {
    const files = [candidate('Media.mkv'), candidate('MediaX.mp4')];
    const result = await resolve(files, { context });
    assert.equal(result.claims.length, 2);
    assert.deepEqual(result.withheldPaths, []);
  });

  await t.test('an unterminated bracket is not an alternate group delimiter', async () => {
    const files = [candidate('Media.mkv'), candidate('Media [unfinished.mp4')];
    const result = await resolve(files, { context });
    assert.equal(result.claims.length, 2);
    assert.deepEqual(result.withheldPaths, []);
  });
});

test('TV versions group by explicit episode or date while different and guessed episodes stay separate', async () => {
  const parent = { ...nestedParent(rootPath + '\\Show\\Season 1'), NativeType: seasonNativeType };
  const files = ['Show.S01E01 - 720p.mkv', 'Different.Title.S01E01 - 1080p.mkv', 'Show.S01E02.mkv', 'Show.S02E01.mkv',
    'Daily.2026-01-02 - 720p.mkv', 'Daily.2026-01-02 - 1080p.mkv', 'Show.01 - Aired.mkv', 'Show.01 - Uncut.mkv']
    .map(name => candidate(name, { directory: parent.Path }));
  const result = await tvPipeline().resolve({ parent, root, collectionContext: collectionContext('tvshows'), candidates: files });
  assert.equal(result.claims.length, 6);
  assert.deepEqual(result.withheldPaths, []);
  assert.deepEqual(result.unclaimedPaths, []);
  for (const [primary, alternate] of [[files[1], files[0]], [files[5], files[4]]]) {
    const claim = result.claims.find(value => value.identityPath === primary.identityPath);
    assert.equal(claim.nativeType, episodeNativeType);
    assert.deepEqual(claim.draft.data.LocalAlternateVersions, [alternate.identityPath]);
    assert.deepEqual(claim.localAlternates.map(value => [value.nativeType, value.identityPath]), [[episodeNativeType, alternate.identityPath]]);
  }
  for (const file of [files[2], files[3], files[6], files[7]]) {
    const claim = result.claims.find(value => value.identityPath === file.identityPath);
    assert.equal(claim.nativeType, episodeNativeType);
    assert.deepEqual(claim.localAlternates, []);
  }
  assert.ok(result.claims.every(claim => claim.draft.columns.IsInMixedFolder));
});

test('a TV stack remains the primary version and owns base Video parts', async () => {
  const parent = { ...nestedParent(rootPath + '\\Show\\Season 1'), NativeType: seasonNativeType };
  const files = ['Show.S01E01 - 2160p.mkv', 'Show.S01E01 - 720p cd2.mkv', 'Show.S01E01 - 720p cd1.mkv',
    'Show.S01E01 - 480p cd1.mkv', 'Show.S01E01 - 480p cd2.mkv']
    .map(name => candidate(name, { directory: parent.Path }));
  const result = await tvPipeline().resolve({ parent, root, collectionContext: collectionContext('tvshows'), candidates: files });
  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.equal(claim.nativeType, episodeNativeType);
  assert.equal(claim.identityPath, files[2].identityPath);
  assert.deepEqual(claim.draft.data.AdditionalParts, [files[1].identityPath]);
  const alternateStack = claim.localAlternates.find(value => value.identityPath === files[3].identityPath);
  assert.deepEqual(alternateStack.draft.data.AdditionalParts, [files[4].identityPath]);
  assert.deepEqual(claim.ownedParts.map(value => [value.nativeType, value.identityPath, value.ownerId]),
    [[videoNativeType, files[1].identityPath, claim.Id], [videoNativeType, files[4].identityPath, alternateStack.Id]]);
  assert.deepEqual(claim.localAlternates.map(value => [value.nativeType, value.identityPath]),
    [[episodeNativeType, files[0].identityPath], [episodeNativeType, files[3].identityPath]]);
  assert.deepEqual(new Set(claim.consumedPaths), new Set(files.map(value => value.identityPath)));
  assert.equal(claim.draft.columns.IsInMixedFolder, false);
});

test('TV multi-file grouping leaves physical directories to the TV resolver', async () => {
  const parent = { ...nestedParent(rootPath + '\\Show'), NativeType: seriesNativeType };
  const namedSeason = candidate('Season 1', { directory: parent.Path, kind: 'directory' });
  const episodeFolder = candidate('Show.S01E01', { directory: parent.Path, kind: 'directory' });
  const result = await tvPipeline().resolve({ parent, root, collectionContext: collectionContext('tvshows'),
    candidates: [namedSeason, episodeFolder], peekDirectory: async directory => directorySnapshot([
      candidate('Show.S01E01.mkv', { directory: directory.identityPath })
    ]) });
  assert.deepEqual(result.claims.map(claim => [claim.identityPath, claim.nativeType, claim.traversal]), [
    [namedSeason.identityPath, seasonNativeType, 'children'], [episodeFolder.identityPath, folderNativeType, 'children']
  ]);
});

test('TV multi-file admission preserves weak and override boundaries while admitting disc images', async () => {
  const parent = { ...nestedParent(rootPath + '\\Show\\Season 1'), NativeType: seasonNativeType };
  const files = ['Show.S01E01 - 720p.mkv', 'Show.S01E01 - 1080p.mkv', 'Show.S01E02.iso', 'Show.S01E03-trailer.mkv']
    .map(name => candidate(name, { directory: parent.Path }));
  const subject = tvPipeline({ classifyIso: async () => null });
  const weak = await subject.resolve({ parent, root, collectionContext: collectionContext('tvshows'), candidates: files, deletionSafe: false });
  assert.deepEqual(weak.claims, []);
  assert.deepEqual(new Set(weak.withheldPaths), new Set(files.map(file => file.identityPath)));
  const result = await subject.resolve({ parent, root, candidates: files, collectionContext: collectionContext('tvshows', {
    contentTypeOverrides: [{ path: files[1].identityPath, collectionType: 'movies' }]
  }) });
  assert.deepEqual(result.claims.map(claim => claim.identityPath), [files[0].identityPath, files[2].identityPath]);
  assert.deepEqual(result.claims[0].localAlternates, []);
  assert.deepEqual(result.claims[0].ownedExtras, []);
  assert.deepEqual(result.claims[1].draft.data, { VideoType: 'Iso', IsoType: null, LocalAlternateVersions: [] });
  assert.deepEqual(result.withheldPaths, [files[1].identityPath]);
  assert.deepEqual(new Set(result.unclaimedPaths), new Set([files[1], files[3]].map(file => file.identityPath)));
});

test('native effective parent type selects ordinary video classification', async () => {
  const unknown = await resolve([candidate('clip.mp4')], { context: collectionContext('unknown') });
  assert.deepEqual(unknown.claims, []);
  const home = await resolve([candidate('clip.mp4')], { context: collectionContext('homevideos', {
    collections: [{ collectionType: 'homevideos' }, { collectionType: 'movies' }] }) });
  assert.equal(home.claims[0].nativeType, videoNativeType);
  const movie = await resolve([candidate('Override Movie (2019).avi')], { context: collectionContext('movies', {
    collections: [{ collectionType: 'movies' }, { collectionType: 'homevideos' }] }) });
  assert.equal(movie.claims[0].nativeType, movieNativeType);
  assert.equal(movie.claims[0].draft.Name, 'Override Movie');
  assert.equal(movie.claims[0].draft.initialColumns.ProductionYear, 2019);
});

test('untyped batches create Movies without merging editions and parentless batches retain Video', async () => {
  const context = collectionContext(null);
  const file = candidate('The Film (2020).mkv');
  const result = await resolve([file], { context });
  assert.equal(result.claims[0].nativeType, movieNativeType);
  assert.equal(result.claims[0].draft.Name, 'The Film');
  assert.equal(result.claims[0].draft.initialColumns.ProductionYear, 2020);
  const versions = [candidate('Media - 1080p.mkv'), candidate('Media - 720p.mkv')];
  const separate = await resolve(versions, { context });
  assert.equal(separate.claims.length, 2);
  for (const claim of separate.claims) {
    assert.equal(claim.nativeType, movieNativeType);
    assert.deepEqual(claim.draft.data.LocalAlternateVersions, []);
  }
  const owned = await resolve([file], { parent: null, context });
  assert.equal(owned.claims[0].nativeType, videoNativeType);
  assert.equal(owned.claims[0].draft.Name, 'The Film (2020)');
  assert.equal(Object.hasOwn(owned.claims[0].draft, 'initialColumns'), false);
});

test('untyped batches honor TV markers and use single Video fallback while protecting TV ancestors and weak reads', async () => {
  const context = collectionContext(null), file = candidate('The Film (2020).mkv');
  const trailer = candidate('The Film-trailer.mkv');
  for (const name of ['TVSHOW.NFO', 'Season.nfo']) for (const kind of ['file', 'directory']) {
    const marker = candidate(name, { kind });
    const result = await resolve([file, marker, trailer], { context,
      peekDirectory: async () => directorySnapshot([]) });
    const claim = result.claims.find(value => value.identityPath === file.identityPath);
    assert.equal(claim.nativeType, videoNativeType);
    assert.equal(claim.draft.Name, 'The Film (2020)');
    assert.equal(claim.draft.columns.IsInMixedFolder, true);
    assert.equal(Object.hasOwn(claim.draft, 'initialColumns'), false);
    assert.equal(result.claims.some(value => value.identityPath === trailer.identityPath), false);
  }
  const series = { ...nestedParent(rootPath + '\\Series'), NativeType: seriesNativeType };
  for (const [parent, collection] of [[{ ...root, IsRoot: true }, context], [series, context],
    [nestedParent(series.Path + '\\Nested'), { ...context, parents: [series, root] }]]) {
    const result = await resolve([file], { parent, context: collection });
    assert.deepEqual(result.claims, []);
  }
  const discPath = rootPath + '\\DVD\\VIDEO_TS';
  const disc = await resolve([candidate('VTS_01_1.VOB', { directory: discPath })],
    { parent: nestedParent(discPath), context });
  assert.deepEqual(disc.claims, [], 'file fallback must not bypass the existing disc structure boundary');
  const weak = await pipeline().resolve({ parent: root, root, collectionContext: context,
    candidates: [file], deletionSafe: false });
  assert.deepEqual(weak.claims, []);
  assert.deepEqual(weak.withheldPaths, [file.identityPath]);
});

test('untyped movie directories collapse editions while retaining TV marker and ancestor boundaries', async () => {
  const context = collectionContext(null), directory = candidate('Film (2020)', { kind: 'directory' });
  const editions = ['Film (2020) - 1080p.mkv', 'Film (2020) - 720p.mkv']
    .map(name => candidate(name, { directory: directory.identityPath }));
  const result = await resolve([directory], { context, peekDirectory: async () => directorySnapshot(editions) });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, movieNativeType);
  assert.equal(result.claims[0].draft.Name, 'Film (2020)');
  assert.equal(result.claims[0].draft.columns.IsInMixedFolder, false);
  assert.equal(result.claims[0].localAlternates.length, 1);
  for (const name of ['TVSHOW.NFO', 'Season.nfo']) {
    const marker = candidate(name, { directory: directory.identityPath });
    const marked = await resolve([directory], { context,
      peekDirectory: async () => directorySnapshot([...editions, marker]) });
    assert.equal(marked.claims[0].nativeType, folderNativeType);
  }
  const series = { ...nestedParent(rootPath + '\\Series'), NativeType: seriesNativeType };
  for (const parent of [null, series, { ...root, IsRoot: true }]) {
    const excluded = await resolve([directory], { parent, context,
      peekDirectory: async () => { throw new Error('Excluded parents must not inspect movie directories.'); } });
    assert.equal(excluded.claims.some(value => value.nativeType === movieNativeType), false);
  }
});

test('disc placeholders preserve file identity and classify only the preceding extension', async () => {
  for (const [name, videoType] of [
    ['Film.dvd.disc', 'Dvd'], ['Film.DVD.DISC', 'Dvd'], ['Film.bluray.disc', 'BluRay'],
    ['Film.brrip.disc', 'BluRay'], ['Film.bd25.disc', 'BluRay'], ['Film.BD50.DISC', 'BluRay'],
    ['Film.hddvd.disc', 'VideoFile'], ['Film.vhs.disc', 'VideoFile'], ['Film.HDTV.disc', 'VideoFile'],
    ['Film.PDTV.disc', 'VideoFile'], ['Film.DSR.disc', 'VideoFile'], ['Film.unknown.disc', 'VideoFile'],
    ['Film.disc', 'VideoFile'], ['Film.dvd.unknown.disc', 'VideoFile'], ['Film-trailer.disc', 'VideoFile']
  ]) {
    const file = candidate(name);
    const raw = resolveOrdinaryVideoFile(file);
    assert.equal(raw.Path, file.identityPath);
    assert.equal(raw.Name, name.slice(0, -5));
    assert.equal(raw.VideoType, videoType, name);
    assert.equal(raw.IsPlaceHolder, true);
    assert.equal(raw.IsShortcut === true, false);
    assert.equal(raw.ExtraType, null, 'stub names are not video extras');
    assert.equal(isNativeVideoFileName(name), false, 'stub admission does not change raw video extension qualification');
    const result = await resolve([file], { context: collectionContext('movies') });
    assert.equal(result.claims.length, 1, name);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, movieNativeType);
    assert.equal(claim.identityPath, file.identityPath);
    assert.equal(claim.draft.IsFolder, false);
    assert.equal(claim.draft.data.VideoType, videoType);
    assert.equal(claim.draft.data.IsPlaceHolder, true);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('a movie directory containing one placeholder retains the nested file as its source', async () => {
  const directory = candidate('Feature', { kind: 'directory' });
  const file = candidate('Feature.dvd.disc', { directory: directory.identityPath });
  const result = await resolve([directory], { context: collectionContext('movies'),
    peekDirectory: async () => directorySnapshot([file]) });
  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.equal(claim.identityPath, file.identityPath);
  assert.equal(claim.accessPath, file.accessPath);
  assert.equal(claim.entry.kind, 'file');
  assert.equal(claim.draft.IsFolder, false);
  assert.equal(claim.draft.data.IsPlaceHolder, true);
  assert.equal(claim.draft.data.VideoType, 'Dvd');
  assert.deepEqual(claim.replacementPaths, [directory.identityPath]);
  assert.deepEqual(result.withheldPaths, []);
});

test('DVD and Blu-ray placeholder owners exclude unmatched sibling extras while ordinary stubs retain file-owner rules', async () => {
  const parent = nestedParent(rootPath + '\\Feature');
  for (const suffix of ['dvd.disc', 'bluray.disc', 'disc']) {
    const owner = candidate(`Feature.${suffix}`, { directory: parent.Path });
    const extra = candidate('Unrelated-featurette.mkv', { directory: parent.Path });
    const result = await resolve([owner, extra], { parent, context: collectionContext('movies') });
    assert.equal(result.claims.length, 1);
    const [claim] = result.claims;
    assert.equal(claim.identityPath, owner.identityPath);
    assert.equal(claim.entry.kind, 'file');
    assert.equal(claim.ownedExtras.length, suffix === 'disc' ? 1 : 0);
    if (suffix === 'disc') {
      assert.equal(claim.ownedExtras[0].identityPath, extra.identityPath);
      assert.equal(claim.ownedExtras[0].ownerId, claim.Id);
    }
    assert.deepEqual(result.unclaimedPaths, suffix === 'disc' ? [] : [extra.identityPath]);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('disc images use storage classification without becoming directory items', async () => {
  const files = [
    candidate('Movie.IMG'),
    candidate('Movie.iso')
  ];
  const requested = [];
  const result = await resolve(files, { classifyIso: async candidate => {
    requested.push(candidate);
    return candidate.identityPath === files[0].identityPath ? 'Dvd' : 'BluRay';
  } });

  assert.equal(result.claims.length, 2);
  assert.deepEqual(new Set(requested), new Set(files));
  for (const claim of result.claims) {
    assert.equal(claim.entry.kind, 'file');
    assert.equal(claim.draft.IsFolder, false);
    assert.equal(claim.draft.data.VideoType, 'Iso');
    assert.equal(claim.draft.data.IsoType, claim.identityPath === files[0].identityPath ? 'Dvd' : 'BluRay');
  }
  assert.deepEqual(result.unclaimedPaths, []);
});

test('ISO path hints use the complete identity before consulting the storage classifier', async () => {
  for (const [directory, name, expected] of [
    [rootPath + '\\DVD Archive', 'Film.img', 'Dvd'],
    [rootPath + '\\BluRay Archive', 'Film.ISO', 'BluRay'],
    [rootPath + '\\BLURAY Archive', 'Film.DVD.iso', 'Dvd']
  ]) {
    const file = candidate(name, { directory });
    const fields = await resolveVideoSourceFields(file, { classifyIso: () => assert.fail('path hint must avoid image I/O') });
    assert.deepEqual(fields, { VideoType: 'Iso', IsoType: expected });
  }
  const file = candidate('Unknown.iso');
  file.entry.version = { token: 'observed-version' };
  const signal = new AbortController().signal;
  const fields = await resolveVideoSourceFields(file, { signal, classifyIso: async (input, options) => {
    assert.deepEqual(input, file, 'the reader receives the observed identity, access path and version');
    assert.equal(options.signal.aborted, false);
    return 'BluRay';
  } });
  assert.deepEqual(fields, { VideoType: 'Iso', IsoType: 'BluRay' });
});

test('ISO directory collapse preserves source consistency failures but logs a malformed image', async () => {
  const directory = candidate('Unknown', { kind: 'directory' });
  const file = candidate('Unknown.iso', { directory: directory.identityPath });
  const options = { context: collectionContext('movies'), peekDirectory: async () => directorySnapshot([file]) };
  const changed = new StorageError('version-changed', 'The observed image changed.');
  await assert.rejects(resolve([directory], { ...options, classifyIso: async () => { throw changed; } }),
    { code: changed.code, message: changed.message });
  await assert.rejects(resolve([directory], options), /ISO resolution requires a storage classifier/u);
  const malformed = new Error('No valid UDF root.'), logged = [];
  const result = await resolve([directory], { ...options, classifyIso: async () => { throw malformed; },
    logger: { error: (...args) => logged.push(args) } });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].identityPath, file.identityPath);
  assert.equal(result.claims[0].draft.data.VideoType, 'Iso');
  assert.equal(result.claims[0].draft.data.IsoType, null);
  assert.deepEqual(result.withheldPaths, []);
  for (const [error] of logged) assert.equal(error.message, malformed.message);
});

test('ISO local versions retain their own disc types while subtype parts use native Video coercion', async () => {
  const parent = nestedParent(rootPath + '\\Media');
  const versions = ['Media.iso', 'Media - 720p.img'].map(name => candidate(name, { directory: parent.Path }));
  const result = await resolve(versions, { parent, context: collectionContext('movies'),
    classifyIso: async input => input.identityPath === versions[0].identityPath ? 'Dvd' : 'BluRay' });
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].draft.data.IsoType, 'Dvd');
  assert.equal(result.claims[0].localAlternates[0].draft.data.VideoType, 'Iso');
  assert.equal(result.claims[0].localAlternates[0].draft.data.IsoType, 'BluRay');
  for (const [collectionType, nativeType] of [['homevideos', videoNativeType], ['movies', movieNativeType],
    ['musicvideos', musicVideoNativeType], ['tvshows', episodeNativeType]]) {
    const files = ['Media - 1080p cd1.iso', 'Media - 1080p cd2.iso'].map(name => candidate(name, { directory: parent.Path }));
    const options = { classifyIso: async () => 'Dvd' };
    const subject = collectionType === 'tvshows' ? tvPipeline(options) : pipeline(options);
    const { claims } = await subject.resolve({ parent, root, collectionContext: collectionContext(collectionType), candidates: files });
    assert.equal(claims.length, 1, collectionType);
    const [claim] = claims;
    assert.equal(claim.nativeType, nativeType);
    assert.equal(claim.draft.data.IsoType, 'Dvd');
    assert.deepEqual(claim.draft.data.AdditionalParts, [files[1].identityPath]);
    const [part] = claim.ownedParts;
    assert.equal(part.nativeType, videoNativeType);
    assert.equal(part.ownerId, claim.Id);
    assert.equal(part.draft.data.VideoType, 'Iso');
    assert.equal(part.draft.data.IsoType, nativeType === videoNativeType ? 'Dvd' : undefined);
  }
});

test('ISO trailer and featurette extras retain their source types and observed storage identities', async () => {
  const parent = nestedParent(rootPath + '\\Feature');
  const files = ['Feature.mkv', 'Feature-trailer.iso', 'Feature-featurette.img']
    .map(name => candidate(name, { directory: parent.Path }));
  const requested = [];
  const result = await resolve(files, { parent, context: collectionContext('movies'), classifyIso: async input => {
    requested.push(input);
    return input.identityPath === files[1].identityPath ? 'Dvd' : 'BluRay';
  } });
  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.deepEqual(new Set(requested), new Set(files.slice(1)));
  assert.equal(claim.ownedExtras.length, 2);
  for (const [file, nativeType, isoType] of [[files[1], trailerNativeType, 'Dvd'], [files[2], videoNativeType, 'BluRay']]) {
    const extra = claim.ownedExtras.find(value => value.identityPath === file.identityPath);
    assert.equal(extra.nativeType, nativeType);
    assert.equal(extra.ownerId, claim.Id);
    assert.equal(extra.draft.data.VideoType, 'Iso');
    assert.equal(extra.draft.data.IsoType, isoType);
  }
  assert.deepEqual(result.withheldPaths, []);
});

test('shortcut and placeholder stacks retain source flags only for same-type base Video parts', async () => {
  for (const [collectionType, nativeType] of [['homevideos', videoNativeType], ['movies', movieNativeType],
    ['musicvideos', musicVideoNativeType], ['tvshows', episodeNativeType]]) for (const [extension, flag] of [
    ['strm', 'IsShortcut'], ['disc', 'IsPlaceHolder']
  ]) {
    const parent = nestedParent(rootPath + '\\Media');
    const files = [`Media - 1080p cd1.${extension.toUpperCase()}`, `Media - 1080p cd2.${extension}`]
      .map(name => candidate(name, { directory: parent.Path }));
    const subject = collectionType === 'tvshows' ? tvPipeline() : pipeline();
    const result = await subject.resolve({ parent, root, collectionContext: collectionContext(collectionType), candidates: files });
    assert.equal(result.claims.length, 1, collectionType);
    const [claim] = result.claims;
    assert.equal(claim.nativeType, nativeType);
    assert.equal(claim.draft.data[flag], true);
    assert.deepEqual(claim.draft.data.AdditionalParts, [files[1].identityPath]);
    const [part] = claim.ownedParts;
    assert.equal(part.nativeType, videoNativeType);
    assert.equal(part.ownerId, claim.Id);
    assert.equal(part.draft.data.VideoType, 'VideoFile');
    assert.equal(part.draft.data[flag] === true, nativeType === videoNativeType);
    assert.deepEqual(result.withheldPaths, []);
  }
});

test('STRM trailer, featurette and theme-song extras retain their own shortcut identities', async () => {
  const parent = nestedParent(rootPath + '\\Feature');
  const files = ['Feature.mkv', 'Feature-trailer.strm', 'Feature-featurette.STRM', 'theme.strm']
    .map(name => candidate(name, { directory: parent.Path }));
  const result = await resolve(files, { parent, context: collectionContext('movies') });
  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.equal(claim.identityPath, files[0].identityPath);
  assert.deepEqual(new Set(claim.ownedExtras.map(extra => extra.identityPath)), new Set(files.slice(1).map(file => file.identityPath)));
  for (const [file, nativeType] of [[files[1], trailerNativeType], [files[2], videoNativeType], [files[3], audioNativeType]]) {
    const extra = claim.ownedExtras.find(value => value.identityPath === file.identityPath);
    assert.equal(extra.nativeType, nativeType);
    assert.equal(extra.ownerId, claim.Id);
    assert.equal(extra.draft.data.IsShortcut, true);
  }
  assert.deepEqual(result.withheldPaths, []);
});

test('video files inside VIDEO_TS and BDMV structures remain unclaimed', async t => {
  for (const [name, relativeParent, filename] of [
    ['VIDEO_TS', 'DVD\\VIDEO_TS', 'VTS_01_1.VOB'],
    ['BDMV', 'BluRay\\BDMV\\STREAM', '00001.m2ts']
  ]) await t.test(name, async () => {
    const path = `${rootPath}\\${relativeParent}`;
    const file = candidate(filename, { directory: path });
    const result = await resolve([file], { parent: nestedParent(path) });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.unclaimedPaths, [file.identityPath]);
  });
});

test('samples and extras remain unclaimed while unmatched stack-shaped home videos stay standalone', async () => {
  const files = [
    candidate('sample.mp4'),
    candidate('Movie.sample.mkv'),
    candidate('Movie-trailer.mov'),
    candidate('Movie-trailer2.mov'),
    candidate('Movie-featurette.avi'),
    candidate('Movie-extra.webm'),
    candidate('Movie-extra12.webm'),
    candidate('Movie.sample3.mkv'),
    candidate('Movie cd1.mkv'),
    candidate('Movie.part2.mp4'),
    candidate('Movie [disk A].avi')
  ];
  const result = await resolve(files);

  assert.deepEqual(new Set(result.claims.map(claim => claim.identityPath)), new Set(files.slice(8).map(file => file.identityPath)));
  assert.deepEqual(new Set(result.unclaimedPaths), new Set(files.slice(0, 8).map(file => file.identityPath)));
});

test('trailing digits alone do not turn the native extra filename token into a suffix rule', async () => {
  const file = candidate('trailer2.mp4');
  const result = await resolve([file]);

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].nativeType, videoNativeType);
  assert.equal(result.claims[0].draft.Name, 'trailer2');
});

test('pipeline advertises the narrow production-media capability scope without broadening it', () => {
  const subject = pipeline();

  assert.deepEqual(subject.capabilities, {
    resolvesProductionMediaFiles: true,
    productionMediaScopes: ['ordinary-movies-homevideos-and-musicvideos']
  });
  assert.equal(Object.isFrozen(subject.capabilities), true);
  assert.equal(Object.isFrozen(subject.capabilities.productionMediaScopes), true);
  assert.equal(subject.manages({ NativeType: videoNativeType, IsFolder: false }), true);
  assert.equal(subject.manages({ NativeType: movieNativeType, IsFolder: false }), true);
  assert.equal(subject.manages({ NativeType: trailerNativeType, IsFolder: false }), true);
  assert.equal(subject.manages({ NativeType: audioNativeType, IsFolder: false }), true);
  assert.equal(subject.manages({ NativeType: movieNativeType, IsFolder: true }), false);
});
