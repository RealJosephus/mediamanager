import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import {
  createVideoFileResolver,
  movieNativeType,
  musicVideoNativeType,
  trailerNativeType,
  videoNativeType
} from '../../src/library/video-file-resolver.js';
import { audioNativeType } from '../../src/library/audio-item-resolver.js';

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

function pipeline() {
  return new DirectoryItemResolverPipeline({
    resolvers: [createVideoFileResolver()],
    programDataPath
  });
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
  peekDirectory
} = {}) {
  return pipeline().resolve({ parent, root, collectionContext: context, candidates, peekDirectory });
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
      peekDirectory: async current => {
        assert.equal(current, directory);
        return directorySnapshot(children);
      }
    });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.withheldPaths, [directory.identityPath]);
    assert.deepEqual(result.unclaimedPaths, [directory.identityPath]);
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
    assert.deepEqual(result.withheldPaths, [files[3].identityPath]);
    assert.equal(result.withheldPaths.includes(files[3].identityPath), true);
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

  await t.test('a stacked extra does not turn the primary movie into an alternate group', async () => {
    const files = [
      candidate('Media-featurette cd1.mkv'),
      candidate('Media-featurette cd2.mkv'),
      candidate('Media.mkv')
    ];
    const result = await resolve(files, { context });

    assert.deepEqual(result.withheldPaths, []);
    assert.deepEqual(result.claims.map(value => value.identityPath), [files[2].identityPath]);
    assert.deepEqual(result.claims[0].draft.data.LocalAlternateVersions, [files[0].identityPath]);
    assert.deepEqual(result.claims[0].ownedParts, []);
    assert.deepEqual(result.unclaimedPaths, []);
  });

  for (const extension of ['disc', 'iso', 'img', 'strm']) {
    await t.test(`.${extension} potential primary with an ordinary version`, async () => {
      const files = [candidate(`Media.${extension}`), candidate('Media - 1080p.mkv')];
      const result = await resolve(files, { context });

      assert.deepEqual(result.claims, []);
      assert.deepEqual(new Set(result.withheldPaths), new Set(files.map(value => value.identityPath)));
    });
  }

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

test('native effective parent type selects ordinary video classification', async () => {
  const unknown = await resolve([candidate('clip.mp4')], { context: collectionContext(null) });
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

test('disc images, stubs, and internet streams remain unclaimed', async () => {
  const files = [
    candidate('Movie.disc'),
    candidate('Movie.IMG'),
    candidate('Movie.iso'),
    candidate('Movie.STRM')
  ];
  const result = await resolve(files);

  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.unclaimedPaths, files.map(file => file.identityPath).sort((left, right) => left.localeCompare(right, 'en')));
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

test('samples and extras remain withheld while unmatched stack-shaped home videos stay standalone', async () => {
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
