import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseLosslessJson } from '../../src/core/json.js';
import { filterResolutionCandidates } from '../../src/library/resolution-ignore.js';
import { DirectoryItemResolverPipeline } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { applyNativeItemValues, newNativeItemEntity } from '../../src/library/native-item-entity.js';
import { dateText, MIN_DATE } from '../../src/library/records.js';
import { discoveryFixture, projectItem, projectDiscovery } from './video-discovery-fixture.js';
import { projectStatePath } from './fixture-state-path.js';

const root = new URL('./fixtures/resolution-ignore-chain/', import.meta.url);
const repository = new URL('../../', import.meta.url);
const [input, native, provenance] = await Promise.all(['input.json', 'native.json', 'provenance.json']
  .map(async file => parseLosslessJson(await readFile(new URL(file, root), 'utf8'))));

test('resolution ignore recording seals actual pre-multi rule/resolver order and complete original projections', async () => {
  for (const file of provenance.fixtureFiles) assert.equal(createHash('sha256')
    .update(await readFile(new URL(file.path, repository))).digest('hex'), file.sha256, file.path);
  assert.equal(native.actualFrozenResolutionIgnoreChain, true);
  assert.equal(native.inputSha256, provenance.fixtureFiles[0].sha256);
  assert.equal(native.scope, provenance.scope); assert.deepEqual(native.assemblies, provenance.assemblies);
  assert.deepEqual(native.results.map(result => result.name), input.map(sample => sample.name));
  assert.equal(native.results.length, 21);
});

for (const dialect of ['postgres']) for (const sample of input) test(`${dialect}: native resolution ignore chain ${sample.name}`, {
  skip: dialect === 'postgres' && !process.env.MEDIAMANAGER_TEST_POSTGRES
}, async t => {
  const value = await discoveryFixture(t, dialect, sample), { fixture, loaded, calls } = value;
  const normalize = value => projectStatePath(value, fixture.stateRoot);
  const candidates = [];
  for (const filename of sample.files) {
    const identityPath = path.join(fixture.stateRoot, 'media', filename), accessPath = '/discovery-write/discovery/' + filename;
    candidates.push({ identityPath, accessPath, entry: await fixture.vfs.stat(accessPath) });
  }
  const filtered = await filterResolutionCandidates(candidates, { ignoreRule: fixture.ignoreRule, parent: loaded.parent,
    applicationRootPath: path.join(fixture.stateRoot, 'root') });
  const video = createVideoFileResolver();
  const resolver = { ...video,
    async resolveMultiple(context) {
      calls.push({ action: 'multi', files: context.available.map(candidate => normalize(candidate.identityPath)), collectionType: 'movies' });
      return video.resolveMultiple(context);
    },
    resolveFile(context) {
      calls.push({ action: 'resolve', path: normalize(context.candidate.identityPath) });
      return video.resolveFile(context);
    }
  };
  const pipeline = new DirectoryItemResolverPipeline({ resolvers: [resolver], programDataPath: fixture.stateRoot, configuration: fixture.configuration });
  const result = await pipeline.resolve({ parent: loaded.parent, root: { Id: '98c00000-0000-0000-0000-000000000099' },
    candidates: filtered, collectionContext: { collectionType: 'movies' } });
  const resolved = result.claims.map(claim => applyNativeItemValues(newNativeItemEntity(claim.nativeType), {
    ...claim.draft.columns, ...claim.draft.initialColumns, ...claim.draft.data,
    Id: claim.Id, Name: claim.draft.Name, Path: claim.identityPath, ParentId: loaded.parent.Id,
    Size: claim.entry.size, DateCreated: dateText(claim.entry.created), DateModified: dateText(claim.entry.modified), DateLastSaved: MIN_DATE
  }));
  const actual = await projectDiscovery(fixture, loaded, sample, { ...value, resolved: null, exception: null });
  actual.resolved = resolved.map(item => ({ ...projectItem(item, fixture.stateRoot), alternates: item.LocalAlternateVersions.map(normalize) }));
  assert.deepEqual(actual, native.results.find(result => result.name === sample.name));
});
