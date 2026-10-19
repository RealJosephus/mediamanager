import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  resolveVideoExtraCandidate,
  createVideoFileResolver,
  trailerNativeType,
  videoNativeType
} from '../../src/library/video-file-resolver.js';
import { audioNativeType } from '../../src/library/audio-item-resolver.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';

const fixtureUrl = new URL('./fixtures/video-extras/', import.meta.url);
const readJson = async name => JSON.parse(await readFile(new URL(name, fixtureUrl), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const programDataPath = 'C:\\ProgramData\\MediaManager';
const rootPath = 'Z:\\Movies';
const root = Object.freeze({ Id: '00000000-0000-0000-0000-000000000001', Path: rootPath });

function candidate(name, { directory = rootPath, kind = 'file' } = {}) {
  return {
    identityPath: `${directory}\\${name}`,
    accessPath: `/movies/${name.replaceAll('\\', '/')}`,
    entry: { kind, name }
  };
}

async function resolve(candidates, { parentPath = `${rootPath}\\Film`, peekDirectory, localization } = {}) {
  const pipeline = new DirectoryItemResolverPipeline({
    programDataPath,
    resolvers: [createVideoFileResolver({ localization })]
  });
  return pipeline.resolve({
    parent: Object.freeze({ Id: '00000000-0000-0000-0000-000000000002', Path: parentPath }),
    root,
    collectionContext: Object.freeze({ collectionType: 'movies', collectionTypeSource: 'collection-folder' }),
    candidates,
    peekDirectory
  });
}

test('video-extra oracle is sealed to its portable fixture and frozen source provenance', async () => {
  const provenance = await readJson('provenance.json');
  for (const file of provenance.fixtureFiles) {
    const fileUrl = file.path === 'tests/Directory.Build.props'
      ? new URL('../../../Directory.Build.props', fixtureUrl)
      : new URL(file.path.split('/').at(-1), fixtureUrl);
    assert.equal(sha256(await readFile(fileUrl)), file.sha256, file.path);
  }
  const native = await readJson('native.json');
  assert.equal(native.actualFrozenVideoExtraResolution, true);
  assert.equal(native.scope, provenance.scope);
  assert.deepEqual(native.sourceFiles, provenance.sourceFiles.map(value => value.path));
  assert.deepEqual(native.assemblies.map(value => ({ name: value.name, sha256: value.sha256 })),
    provenance.assemblies.filter(value => value.name !== 'jellyfin.dll')
      .map(value => ({ ...value, name: value.name.replace(/\.dll$/u, '') })));
  assert.equal(fileURLToPath(fixtureUrl).endsWith('video-extras\\') || fileURLToPath(fixtureUrl).endsWith('video-extras/'), true);
});

test('video-extra candidate classification matches the actual frozen resolver', async () => {
  const [input, native] = await Promise.all([readJson('input.json'), readJson('native.json')]);
  assert.deepEqual(native.results.map(value => value.name), input.map(value => value.name));
  for (let groupIndex = 0; groupIndex < input.length; groupIndex++) {
    const sample = input[groupIndex], expected = native.results[groupIndex];
    for (const candidate of expected.candidates) {
      const actual = resolveVideoExtraCandidate(sample.ownerPath, candidate.path);
      assert.deepEqual({
        valid: actual.valid,
        extraType: actual.extraType,
        extraTypeValue: actual.extraTypeValue,
        ruleType: actual.ruleType,
        ruleToken: actual.ruleToken,
        resolvedName: actual.resolvedName,
        resolvedYear: actual.resolvedYear
      }, {
        valid: candidate.valid,
        extraType: candidate.extraType,
        extraTypeValue: candidate.extraTypeValue,
        ruleType: candidate.ruleType,
        ruleToken: candidate.ruleToken,
        resolvedName: candidate.resolvedName,
        resolvedYear: candidate.resolvedYear
      }, `${sample.name}: ${candidate.path}`);
      const expectedNativeType = candidate.extraTypeValue == null ? null
        : candidate.extraTypeValue === 2 ? trailerNativeType
          : candidate.extraTypeValue === 8 ? audioNativeType : videoNativeType;
      assert.equal(actual.nativeType, expectedNativeType, candidate.path);
    }
  }
});

test('owned extras retain native ordering, localization, version ownership and typed-folder state', async () => {
  const parentPath = `${rootPath}\\Film`;
  const primary = candidate('Film.mkv', { directory: parentPath });
  const alternate = candidate('Film - Cut.mkv', { directory: parentPath });
  const primaryTrailer = candidate('Film-trailer.mkv', { directory: parentPath });
  const alternateTrailer = candidate('Film - Cut-trailer.mkv', { directory: parentPath });
  const exactTrailer = candidate('trailer.mkv', { directory: parentPath });
  const trailers = candidate('trailers', { directory: parentPath, kind: 'directory' });
  const teaser = candidate('Teaser.mkv', { directory: trailers.identityPath });
  const official = candidate('Official.mkv', { directory: trailers.identityPath });
  const calls = [];
  const localization = {
    serverCulture: 'x-test',
    text(key, options) {
      calls.push(['text', key, options]);
      return `localized:${key}`;
    },
    format(key, values, options) {
      calls.push(['format', key, values, options]);
      return `${values[0]} #${values[1]}`;
    }
  };

  const result = await resolve([
    trailers,
    exactTrailer,
    primaryTrailer,
    alternateTrailer,
    alternate,
    primary
  ], {
    localization,
    peekDirectory: async current => {
      assert.equal(current, trailers);
      return { listing: { deletionSafe: true }, candidates: [teaser, official] };
    }
  });

  assert.equal(result.claims.length, 1);
  const [claim] = result.claims;
  assert.equal(claim.ownsOwnedExtras, true);
  assert.equal(claim.ownedExtrasDeletionSafe, true);
  assert.deepEqual(claim.ownedExtras.map(extra => extra.identityPath), [
    alternateTrailer.identityPath,
    primaryTrailer.identityPath,
    exactTrailer.identityPath,
    official.identityPath,
    teaser.identityPath
  ]);
  const byPath = new Map(claim.ownedExtras.map(extra => [extra.identityPath, extra]));
  assert.equal(byPath.get(primaryTrailer.identityPath).draft.Name, 'localized:NameExtraTrailer');
  assert.equal(byPath.get(exactTrailer.identityPath).draft.Name, 'localized:NameExtraTrailer #2');
  assert.equal(byPath.get(alternateTrailer.identityPath).draft.Name, 'Film - Cut');
  assert.equal(byPath.get(alternateTrailer.identityPath).ownerId, claim.localAlternates[0].Id,
    'the longest same-directory version prefix selects the alternate owner');
  assert.equal(byPath.get(primaryTrailer.identityPath).ownerId, claim.Id);
  assert.equal(byPath.get(official.identityPath).ownerId, claim.Id,
    'typed-directory extras default to the primary version');
  assert.equal(byPath.get(official.identityPath).draft.columns.IsInMixedFolder, true);
  assert.equal(byPath.get(teaser.identityPath).draft.columns.IsInMixedFolder, true);
  assert.deepEqual(calls, [
    ['text', 'NameExtraTrailer', { culture: 'x-test' }],
    ['text', 'NameExtraTrailer', { culture: 'x-test' }],
    ['format', 'NameExtraNumbered', ['localized:NameExtraTrailer', 2], { culture: 'x-test' }]
  ]);
});

test('weak typed-extra snapshots retain additions but withhold deletion authority', async () => {
  const parentPath = `${rootPath}\\Film`;
  const primary = candidate('Film.mkv', { directory: parentPath });
  const trailers = candidate('trailers', { directory: parentPath, kind: 'directory' });
  const teaser = candidate('Teaser.mkv', { directory: trailers.identityPath });

  const result = await resolve([primary, trailers], {
    peekDirectory: async current => {
      assert.equal(current, trailers);
      return { listing: { deletionSafe: false }, candidates: [teaser] };
    }
  });

  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0].ownedExtras.length, 1);
  assert.equal(result.claims[0].ownedExtras[0].identityPath, teaser.identityPath);
  assert.equal(result.claims[0].ownsOwnedExtras, true);
  assert.equal(result.claims[0].ownedExtrasDeletionSafe, false);
});

test('theme-song resolution keeps the audio resolver filename instead of video metadata parsing', async () => {
  const parentPath = `${rootPath}\\Film`;
  const primary = candidate('Film.mkv', { directory: parentPath });
  const themes = candidate('theme-music', { directory: parentPath, kind: 'directory' });
  const cue = candidate('Cue (2024).mp3', { directory: themes.identityPath });

  const result = await resolve([primary, themes], {
    peekDirectory: async current => {
      assert.equal(current, themes);
      return { listing: { deletionSafe: true }, candidates: [cue] };
    }
  });

  const [extra] = result.claims[0].ownedExtras;
  assert.equal(extra.nativeType, audioNativeType);
  assert.equal(extra.extraType, 8);
  assert.equal(extra.draft.Name, 'Cue (2024)');
  assert.equal(Object.hasOwn(extra.draft, 'initialColumns'), false);
  assert.equal(Object.hasOwn(extra.draft, 'data'), false);
});

test('mixed movie folders never assign an ambiguous owner and withhold extra-shaped candidates', async () => {
  const parentPath = `${rootPath}\\Mixed`;
  const first = candidate('First.mkv', { directory: parentPath });
  const second = candidate('Second.mkv', { directory: parentPath });
  const trailer = candidate('First-trailer.mkv', { directory: parentPath });

  const result = await resolve([first, trailer, second], { parentPath });

  assert.deepEqual(result.claims.map(claim => claim.identityPath), [first.identityPath, second.identityPath]);
  assert.ok(result.claims.every(claim => claim.ownsOwnedExtras === false && claim.ownedExtras.length === 0));
  assert.deepEqual(result.withheldPaths, [trailer.identityPath]);
  assert.deepEqual(result.unclaimedPaths, [trailer.identityPath]);
});
