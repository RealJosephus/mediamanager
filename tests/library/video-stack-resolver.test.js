import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createVideoFileResolver,
  movieNativeType,
  videoNativeType
} from '../../src/library/video-file-resolver.js';

const fixtureUrl = new URL('./fixtures/video-stacks/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, fixtureUrl), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const root = Object.freeze({ Id: '97000000-0000-0000-0000-000000000001', Path: 'Z:\\Media' });

function candidate(parentPath, name) {
  return {
    identityPath: `${parentPath}\\${name}`,
    accessPath: `/media/${name}`,
    entry: { kind: 'file', name }
  };
}

test('video-stack oracle is sealed to its portable fixture and frozen source provenance', async () => {
  const provenance = await readJson('provenance.json');
  for (const file of provenance.fixtureFiles) {
    const fileUrl = file.path === 'tests/Directory.Build.props'
      ? new URL('../../../Directory.Build.props', fixtureUrl)
      : new URL(file.path.split('/').at(-1), fixtureUrl);
    assert.equal(sha256(await readFile(fileUrl)), file.sha256, file.path);
  }
  const native = await readJson('native.json');
  assert.equal(native.actualFrozenVideoStackResolution, true);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies.map(value => ({ name: `${value.name}.dll`, sha256: value.sha256 })),
    provenance.assemblies.filter(value => value.name !== 'jellyfin.dll'));
  assert.equal(fileURLToPath(fixtureUrl).endsWith('video-stacks\\')
    || fileURLToPath(fixtureUrl).endsWith('video-stacks/'), true);
});

test('file-stack grouping and item projection match the actual frozen resolvers', async () => {
  const [input, native] = await Promise.all([readJson('input.json'), readJson('native.json')]);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  const resolver = createVideoFileResolver();
  for (let index = 0; index < input.length; index++) {
    const sample = input[index], expected = native.results[index];
    const parentPath = `Z:\\Media\\A\\${sample.parentName}`;
    const available = sample.files.map(name => candidate(parentPath, name));
    const result = await resolver.resolveMultiple({
      parent: { Id: '97000000-0000-0000-0000-000000000002', Path: parentPath },
      root,
      collectionContext: { collectionType: sample.collectionType, collectionTypeSource: 'collection-folder' },
      available
    });
    const actualItems = result.items.map(item => ({
      nativeType: item.nativeType,
      Name: item.draft.Name,
      Path: item.primary.identityPath,
      ProductionYear: item.draft.initialColumns?.ProductionYear ?? null,
      IsInMixedFolder: item.draft.columns.IsInMixedFolder,
      AdditionalParts: item.draft.data.AdditionalParts ?? [],
      LocalAlternateVersions: item.draft.data.LocalAlternateVersions,
      VideoType: item.draft.data.VideoType
    }));
    assert.deepEqual(actualItems, expected.items, sample.name);
    for (const item of result.items) {
      for (const owner of [item, ...item.localAlternates]) {
        assert.deepEqual(item.ownedParts.filter(part => part.owner.identityPath === owner.primary.identityPath)
          .map(part => part.primary.identityPath), owner.draft.data.AdditionalParts ?? []);
      }
      assert.ok(item.ownedParts.every(part => part.nativeType === videoNativeType));
      assert.ok(item.localAlternates.every(alternate => alternate.nativeType == null
        || alternate.nativeType === item.nativeType));
      assert.equal(item.nativeType, sample.collectionType === 'movies' ? movieNativeType : videoNativeType);
    }
  }
});

test('each stacked version declares and owns its additional parts', async () => {
  const resolver = createVideoFileResolver();
  const parentPath = 'Z:\\Media\\A\\Film';
  const names = ['Film - Theatrical cd2.mkv', 'Film - Director cd1.mkv',
    'Film - Theatrical cd1.mkv', 'Film - Director cd2.mkv'];
  const result = await resolver.resolveMultiple({
    parent: { Id: '97000000-0000-0000-0000-000000000002', Path: parentPath },
    root,
    collectionContext: { collectionType: 'movies', collectionTypeSource: 'collection-folder' },
    available: names.map(name => candidate(parentPath, name))
  });
  const [item] = result.items;
  assert.deepEqual(item.ownedParts.map(part => [part.owner.entry.name, part.primary.entry.name]), [
    ['Film - Director cd1.mkv', 'Film - Director cd2.mkv'],
    ['Film - Theatrical cd1.mkv', 'Film - Theatrical cd2.mkv']
  ]);
  assert.deepEqual(item.localAlternates.map(alternate => alternate.primary.entry.name), ['Film - Theatrical cd1.mkv']);
  assert.deepEqual(item.localAlternates[0].draft.data.AdditionalParts, [parentPath + '\\Film - Theatrical cd2.mkv']);
  assert.ok(item.consumedPaths.some(value => value.identityPath.endsWith('Film - Theatrical cd2.mkv')));
});
