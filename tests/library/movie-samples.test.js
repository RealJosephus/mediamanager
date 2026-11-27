import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver, resolveVideoExtraCandidate } from '../../src/library/video-file-resolver.js';

const rootPath = '/review/movies',
  parentPath = rootPath + '/Film';
function candidate(name, directory = parentPath, kind = 'file') {
  const identityPath = path.posix.join(directory, name);
  return { identityPath, accessPath: identityPath, entry: { kind, name } };
}
async function scan(candidates, peekDirectory) {
  const resolver = new DirectoryItemResolverPipeline({
    programDataPath: '/review/program',
    resolvers: [createVideoFileResolver()],
  });
  return resolver.resolve({
    parent: { Id: '00000000-0000-0000-0000-000000000002', Path: parentPath },
    root: { Id: '00000000-0000-0000-0000-000000000001', Path: rootPath },
    collectionContext: { collectionType: 'movies', collectionTypeSource: 'collection-folder' },
    candidates,
    peekDirectory,
    deletionSafe: true,
  });
}
test('movie scan keeps numbered sample files attached to their movie', async (t) => {
  const film = candidate('Film.mkv'),
    sample = candidate('sample1.mkv');
  assert.equal(resolveVideoExtraCandidate(film.identityPath, candidate('sample.mkv').identityPath).extraType, 'Sample');
  const result = await scan([film, sample]);
  const items = result.claims.map((claim) => ({
    name: claim.draft.Name,
    extras: claim.ownedExtras?.map((extra) => extra.identityPath) ?? [],
  }));
  t.diagnostic(JSON.stringify(items));
  assert.deepEqual(
    result.claims.flatMap((claim) => claim.ownedExtras ?? []).map((extra) => extra.identityPath),
    [sample.identityPath]
  );
});
test('movie scan finds a sample in the singular sample directory', async (t) => {
  const film = candidate('Film.mkv'),
    folder = candidate('sample', parentPath, 'directory'),
    sample = candidate('preview.mkv', folder.identityPath);
  assert.equal(resolveVideoExtraCandidate(film.identityPath, parentPath + '/samples/preview.mkv').extraType, 'Sample');
  const result = await scan([film, folder], async () => ({ listing: { deletionSafe: true }, candidates: [sample] }));
  t.diagnostic(
    JSON.stringify(
      result.claims.map((claim) => ({
        name: claim.draft.Name,
        extras: claim.ownedExtras?.map((x) => x.identityPath) ?? [],
      }))
    )
  );
  assert.deepEqual(
    result.claims.flatMap((claim) => claim.ownedExtras ?? []).map((extra) => extra.identityPath),
    [sample.identityPath]
  );
});
