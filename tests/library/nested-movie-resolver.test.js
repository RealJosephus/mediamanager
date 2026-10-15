import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';

const root = new URL('./fixtures/nested-movie-resolver/', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const compare = (actual, expected) => assert.deepEqual(actual, expected);
const projection = value => ({ items: value.items, extraFiles: value.extraFiles });
test('nested resolver recording seals actual MovieResolver and VideoListResolver calls', async () => {
  for (const file of Object.values(provenance.files)) assert.equal(hash(await readFile(new URL('../../' + file.path, import.meta.url))), file.sha256, file.path);
  assert.equal(native.actualFrozenNestedMovieResolver, true);
  assert.equal(native.inputSha256, provenance.files.input.sha256);
  assert.equal(native.sourceFilesSha256, provenance.sourceFilesSha256);
  assert.equal(native.candidateVerified, false); assert.equal(provenance.candidateVerified, false);
  assert.equal(input.length, 12); assert.equal(native.results.length, input.length);
  assert.equal(provenance.runtime.jellyfinDll.sha256, 'a43fa24c44677e579fcec79d637789b9f36633d02e5434e76a0e03fa13027767');
  compare(native.results.map(value => value.name), input.map(value => value.name));
});
test('nested resolver comparator detects withheld media, mixed flags and parsed name/year differences', () => {
  const expected = native.results.find(value => value.name === 'nested-year-movie');
  for (const change of [value => { value.items = []; }, value => { value.items[0].IsInMixedFolder = true; },
    value => { value.items[0].Name = 'B'; }, value => { value.items[0].ProductionYear = null; }]) {
    const altered = structuredClone(expected); change(altered);
    assert.throws(() => compare(projection(altered), projection(expected)), assert.AssertionError);
  }
});
for (const sample of input) test('actual nested ordinary resolver projection ' + sample.name, async () => {
  const parentName = sample.parentName ?? 'B';
  const parent = { Id: '97950000-0000-0000-0000-000000000003', Type: 'Folder', IsFolder: true, Path: 'Z:\\Media\\A\\' + parentName };
  const scanRoot = { Id: '97950000-0000-0000-0000-000000000001', Type: 'Folder', IsFolder: true, Path: 'Z:\\Media' };
  const available = sample.files.map(name => ({ identityPath: parent.Path + '\\' + name,
    accessPath: '/library/A/B/' + name, entry: { kind: 'file', name } }));
  const result = await createVideoFileResolver().resolveMultiple({
    parent,
    root: scanRoot,
    collectionContext: { collectionType: sample.collectionType },
    available
  });
  const actual = result ? {
    items: result.items.map(item => ({ nativeType: item.nativeType, Name: item.draft.Name, Path: item.primary.identityPath,
      ProductionYear: item.draft.initialColumns?.ProductionYear ?? null, IsInMixedFolder: item.draft.columns.IsInMixedFolder,
      AdditionalParts: item.draft.data.AdditionalParts ?? [], LocalAlternateVersions: item.draft.data.LocalAlternateVersions ?? [],
      VideoType: item.draft.data.VideoType })), extraFiles: result.extraFiles.map(file => file.identityPath)
  } : { items: null, extraFiles: null };
  compare(actual, projection(native.results.find(value => value.name === sample.name)));
});
