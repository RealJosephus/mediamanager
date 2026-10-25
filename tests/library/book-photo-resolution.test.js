import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createBookItemResolver,
  createPhotoAlbumResolver,
  createPhotoItemResolver,
  parseBookFileName,
} from '../../src/library/index.js';

const root = new URL('./fixtures/book-photo-resolution/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const rawInput = await readFile(new URL('input.json', root), 'utf8');
const rawNative = await readFile(new URL('native.json', root), 'utf8');
const input = JSON.parse(rawInput);
const native = JSON.parse(rawNative);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const rootPath = 'Z:\\media';

function resolverFor(type) {
  return type === 'book' ? createBookItemResolver()
    : type === 'photo' ? createPhotoItemResolver() : createPhotoAlbumResolver();
}

function resolverCandidate(relative, kind) {
  const nativePath = path.win32.join(rootPath, ...relative.split('/'));
  return {
    identityPath: nativePath,
    accessPath: '/media/' + relative,
    entry: { kind, name: path.win32.basename(nativePath), size: kind === 'file' ? 23 : undefined }
  };
}

async function candidateResult(sample) {
  const resolver = resolverFor(sample.resolver);
  const entries = [
    ...(sample.directories ?? []).map(value => resolverCandidate(value, 'directory')),
    ...(sample.files ?? []).map(value => resolverCandidate(value, 'file'))
  ];
  const target = entries.find(value => value.identityPath === path.win32.join(rootPath, ...sample.target.split('/')));
  assert.ok(target, `${sample.name} target`);
  const targetDirectory = path.win32.dirname(target.identityPath);
  const siblings = entries.filter(value => path.win32.dirname(value.identityPath) === targetDirectory);
  const collectionContext = {
    collectionType: sample.collectionType,
    libraryOptions: { EnablePhotos: sample.enablePhotos ?? true }
  };
  const raw = target.entry.kind === 'directory'
    ? await resolver.resolveDirectory({
      collectionContext,
      candidate: target,
      peekDirectory: async () => ({
        listing: { deletionSafe: true },
        candidates: entries.filter(value => path.win32.dirname(value.identityPath) === target.identityPath)
      })
    })
    : resolver.resolveFile({ collectionContext, candidates: siblings, candidate: target, deletionSafe: true });
  if (!raw || raw.withhold) return { priority: resolver.priority / 10, resolved: null };
  const source = raw.itemSource ?? raw.primary;
  const columns = raw.draft.columns ?? {};
  return {
    priority: resolver.priority / 10,
    resolved: {
      type: raw.nativeType,
      name: raw.draft.Name ?? (source.entry.kind === 'file'
        ? path.win32.parse(source.entry.name).name : source.entry.name),
      path: source.identityPath.replace(rootPath, '$MEDIA').replaceAll('\\', '/'),
      IsFolder: raw.draft.IsFolder,
      mediaType: raw.draft.MediaType,
      IsInMixedFolder: columns.IsInMixedFolder ?? false,
      ProductionYear: columns.ProductionYear ?? null,
      seriesName: columns.SeriesName ?? null,
      index: columns.IndexNumber ?? null,
      parentIndex: columns.ParentIndexNumber ?? null
    }
  };
}

test('Book and Photo native resolver fixture is sealed and honestly scoped', async () => {
  for (const file of provenance.fixtureFiles) {
    assert.equal(hash(await readFile(new URL(file.path, repository))), file.sha256, file.path);
  }
  assert.equal(hash(rawInput), native.inputSha256);
  assert.equal(native.actualFrozenBookPhotoResolution, true);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.equal(provenance.reference.head, '208c278b75abd897aefa1e1175126eac5e4dbfaa');
  assert.equal(provenance.capture.sourceFilesSha256,
    '019d8095bcbd46767f0c4e15880e6954dd47e4947c63e47bf3b4b7d9ccd7f2ab');
  assert.equal(provenance.candidateVerified, true);
  assert.deepEqual(native.results.map(result => result.name), input.resolvers.map(sample => sample.name));
});

test('Book filename parsing matches the frozen native parser', () => {
  assert.deepEqual(input.parser.map(source => ({ source, ...parseBookFileName(source) })),
    native.parser.map(value => ({
      source: value.source,
      name: value.Name,
      seriesName: value.SeriesName,
      index: value.Index,
      parentIndex: value.parentIndex,
      year: value.Year
    })));
});

for (const sample of input.resolvers) test(`Book/Photo resolver matches native ${sample.name}`, async () => {
  const expected = native.results.find(result => result.name === sample.name);
  const actual = await candidateResult(sample);
  assert.equal(actual.priority, expected.priority);
  const { parentId: _parentId, ...resolved } = expected.resolved ?? {};
  assert.deepEqual(actual.resolved, expected.resolved == null ? null : resolved);
});
