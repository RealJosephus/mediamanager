import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseLosslessJson } from '../../src/core/json.js';
import { movieNativeType, musicVideoNativeType, videoNativeType } from '../../src/library/video-file-resolver.js';
import { discoveryFixture, projectDiscoveryOutcome } from './video-discovery-fixture.js';
import { resolveDirectoryVideo, projectDirectoryResolution } from './directory-video-fixture.js';

const root = new URL('./fixtures/directory-video-resolution/', import.meta.url), repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('directory resolution seals complete native scenes and original row and file observations', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenDirectoryVideoResolution, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 34);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native directory resolution ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample);
  const resolved = await resolveDirectoryVideo(value, sample);
  const actual = await projectDirectoryResolution(value, sample, resolved);
  assert.deepEqual(projectDiscoveryOutcome(actual), projectDiscoveryOutcome(native.results.find(result => result.name === sample.name)));
});

// These layouts extend the source-audited resolver boundary with real VFS
// enumeration on both stores. They deliberately do not claim a new frozen
// native recording or alter the sealed 34-scene fixture above.
const directDiscSamples = [
  {
    name: 'source-audited movies direct VIDEO_TS',
    collectionType: 'movies', expectedType: 'Movie', resolverType: 'Movie', nativeType: movieNativeType,
    videoType: 'Dvd', entries: ['The Film'], directories: [], files: ['The Film/VIDEO_TS/VTS_01_1.VOB'],
    ignoreFiles: [{ path: 'media/The Film/VIDEO_TS/.ignore', text: '*.VOB' }], ignoredVob: true
  },
  {
    name: 'source-audited musicvideos direct BDMV',
    collectionType: 'musicvideos', expectedType: 'MusicVideo', resolverType: 'MusicVideo', nativeType: musicVideoNativeType,
    videoType: 'BluRay', entries: ['The Film'], directories: [], files: ['The Film/BDMV/index.bdmv']
  },
  {
    name: 'source-audited homevideos direct video_ts.ifo',
    collectionType: 'homevideos', expectedType: 'Video', resolverType: 'Video', nativeType: videoNativeType,
    videoType: 'Dvd', entries: ['The Film'], directories: [], files: ['The Film/video_ts.ifo']
  }
];

for (const dialect of ['postgres']) for (const sample of directDiscSamples) test(`${dialect}: ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample);
  if (sample.ignoredVob) assert.equal(await value.fixture.ignoreRule.shouldIgnore(
    path.join(value.fixture.stateRoot, 'media', 'The Film', 'VIDEO_TS', 'VTS_01_1.VOB'),
    { isDirectory: false }), true, 'the control VOB must be hidden from the ordinary filtered peek');
  const resolved = await resolveDirectoryVideo(value, sample);

  assert.equal(resolved.length, 1);
  const [item] = resolved;
  assert.equal(item.NativeType, sample.nativeType);
  assert.equal(item.Path, path.join(value.fixture.stateRoot, 'media', 'The Film'));
  assert.equal(item.IsFolder, false);
  assert.equal(item.VideoType, sample.videoType);
  assert.equal(item.IsInMixedFolder, false);
  assert.equal(item.ProductionYear, null);
  assert.deepEqual(item.AdditionalParts, []);
  assert.deepEqual(item.LocalAlternateVersions, []);
});
