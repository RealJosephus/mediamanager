import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createAudioBookItemResolver, parseAudioBookName } from '../../src/library/index.js';

const root = new URL('./fixtures/audio-book-resolution/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const rawInput = await readFile(new URL('input.json', root), 'utf8');
const rawNative = await readFile(new URL('native.json', root), 'utf8');
const input = JSON.parse(rawInput);
const native = JSON.parse(rawNative);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const rootPath = 'Z:\\audio-books';
const parentId = '96000000-0000-0000-0000-000000000003';
const otherRootId = '96000000-0000-0000-0000-000000000099';

function resolverCandidate(mediaRoot, relative, kind) {
  const nativePath = path.win32.join(mediaRoot, ...relative.split('/'));
  return {
    identityPath: nativePath,
    accessPath: '/audio-books/' + relative,
    entry: { kind, name: path.win32.basename(nativePath), size: kind === 'file' ? 25 : undefined }
  };
}

function projectClaim(raw, mediaRoot) {
  const source = raw.itemSource ?? raw.primary;
  const columns = raw.draft.columns ?? {};
  const initial = raw.draft.initialColumns ?? {};
  const data = raw.draft.data ?? {};
  return {
    type: raw.nativeType,
    Name: raw.draft.Name ?? (source.entry.kind === 'file'
      ? path.win32.parse(source.entry.name).name : source.entry.name),
    path: source.identityPath.replace(mediaRoot, '$MEDIA').replaceAll('\\', '/'),
    IsFolder: raw.draft.IsFolder,
    mediaType: raw.draft.MediaType,
    IsInMixedFolder: columns.IsInMixedFolder ?? false,
    ProductionYear: columns.ProductionYear ?? null,
    IsShortcut: data.IsShortcut ?? false,
    artists: initial.Artists ?? [],
    albumArtists: initial.AlbumArtists ?? []
  };
}

async function candidateResult(sample) {
  const resolver = createAudioBookItemResolver();
  const mediaRoot = path.win32.join(rootPath, sample.parentName);
  const entries = sample.entries.map(entry => resolverCandidate(mediaRoot, entry.path, entry.kind));
  const collectionContext = { collectionType: sample.collectionType, libraryOptions: {} };
  const parent = { Id: parentId, Path: mediaRoot };
  const scanRoot = { Id: sample.parentTop ? parentId : otherRootId, Path: rootPath };
  if (sample.mode === 'multiple') {
    const raw = resolver.resolveMultiple({ parent, root: scanRoot, collectionContext,
      available: entries, deletionSafe: true });
    return {
      priority: resolver.priority / 10,
      resolved: {
        items: raw?.items?.map(value => projectClaim(value, mediaRoot)) ?? [],
        extraFiles: raw?.extraFiles?.map(value => value.identityPath.replace(mediaRoot, '$MEDIA').replaceAll('\\', '/')) ?? []
      }
    };
  }
  const targetPath = path.win32.join(mediaRoot, ...sample.target.split('/'));
  const target = entries.find(value => value.identityPath === targetPath);
  assert.ok(target, `${sample.name} target`);
  const raw = sample.mode === 'directory'
    ? await resolver.resolveDirectory({ collectionContext, candidate: target,
      peekDirectory: async () => ({ listing: { deletionSafe: true },
        candidates: entries.filter(value => path.win32.dirname(value.identityPath) === target.identityPath) }) })
    : resolver.resolveFile({ collectionContext, candidate: target, deletionSafe: true });
  return { priority: resolver.priority / 10, resolved: !raw || raw.withhold ? null : projectClaim(raw, mediaRoot) };
}

test('AudioBook native resolver fixture is sealed and honestly scoped', async () => {
  for (const file of provenance.fixtureFiles) {
    assert.equal(hash(await readFile(new URL(file.path, repository))), file.sha256, file.path);
  }
  assert.equal(hash(rawInput), native.inputSha256);
  assert.equal(native.actualFrozenAudioBookResolution, true);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(provenance.reference.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.capture.sourceFilesSha256,
    'e7765abe94b337f1a752c6ef789777443a700c31a94e6ca516b04e4b3befe361');
  assert.equal(provenance.candidateVerified, true);
  assert.deepEqual(native.results.map(result => result.name), input.resolvers.map(sample => sample.name));
});

test('AudioBook name parsing matches the frozen native parser', () => {
  assert.deepEqual(input.names.map(source => ({ source, ...parseAudioBookName(source) })),
    native.names.map(value => ({ source: value.source, name: value.Name, year: value.Year })));
});

for (const sample of input.resolvers) test(`AudioBook resolver matches native ${sample.name}`, async () => {
  const expected = native.results.find(result => result.name === sample.name);
  const actual = await candidateResult(sample);
  assert.equal(actual.priority, expected.priority);
  if (sample.mode === 'multiple') {
    const projected = { ...expected.resolved,
      items: expected.resolved.items.map(({ parentId: _parentId, ...item }) => item) };
    assert.deepEqual(actual.resolved, projected);
  } else {
    const { parentId: _parentId, ...resolved } = expected.resolved ?? {};
    assert.deepEqual(actual.resolved, expected.resolved == null ? null : resolved);
  }
});
