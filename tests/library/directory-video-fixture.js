import assert from 'node:assert/strict';
import path from 'node:path';
import { filterResolutionCandidates } from '../../src/library/resolution-ignore.js';
import { DirectoryItemResolverPipeline, folderNativeType } from '../../src/library/directory-item-resolver.js';
import { createVideoFileResolver } from '../../src/library/video-file-resolver.js';
import { createResolvedItemEntity } from '../../src/library/resolved-item-entity.js';
import { dateText } from '../../src/library/records.js';
import { ensureFixtureDirectory } from './ignore-file-fixture.js';
import { projectItem, projectDiscovery } from './video-discovery-fixture.js';

export async function resolveDirectoryVideo(value, sample) {
  const { fixture, loaded, calls } = value;
  if (sample.parentLocked) {
    await fixture.database.update('BaseItems', { Id: loaded.parent.Id }, { IsLocked: true });
    loaded.parent.IsLocked = true;
  }
  for (const name of sample.directories) await ensureFixtureDirectory(fixture, '/discovery-write/discovery/' + name);
  const normalize = value => value?.replace(fixture.stateRoot, '$STATE'), cache = new Map();
  const coreOptions = { ignoreRule: fixture.ignoreRule, parent: loaded.parent, applicationRootPath: path.join(fixture.stateRoot, 'root') };
  const snapshot = async candidate => {
    if (!cache.has(candidate.accessPath)) cache.set(candidate.accessPath, (async () => {
      const listing = await fixture.vfs.list(candidate.accessPath);
      return { listing, candidates: listing.entries.map(entry => ({ identityPath: path.win32.join(candidate.identityPath, entry.name),
        accessPath: path.posix.join(candidate.accessPath, entry.name), entry })) };
    })());
    return cache.get(candidate.accessPath);
  };
  const peekDirectory = async (candidate, options) => {
    const raw = await snapshot(candidate);
    return options?.forExtras ? raw : { ...raw, candidates: await filterResolutionCandidates(raw.candidates, coreOptions) };
  };
  const getExtraCandidates = async candidate => {
    let raw;
    if (candidate) raw = await snapshot(candidate);
    else {
      const accessPath = fixture.identityMap.resolve({ identityPath: loaded.parent.Path, style: 'windows' });
      const listing = await fixture.vfs.list(accessPath), byPath = new Map(candidates.map(value => [value.identityPath, value]));
      raw = { listing, candidates: listing.entries.map(entry => {
        const identityPath = path.join(loaded.parent.Path, entry.name);
        return byPath.get(identityPath) ?? { identityPath, accessPath: path.posix.join(accessPath, entry.name), entry };
      }) };
    }
    const filtered = [];
    for (const value of raw.candidates) if (!await fixture.ignoreRule.shouldIgnore(value.identityPath, { isDirectory: value.entry.kind === 'directory' })) filtered.push(value);
    return { ...raw, candidates: filtered };
  };
  const candidates = [];
  for (const name of sample.entries) {
    const accessPath = '/discovery-write/discovery/' + name;
    candidates.push({ identityPath: path.join(fixture.stateRoot, 'media', name), accessPath, entry: await fixture.vfs.stat(accessPath) });
  }
  const video = createVideoFileResolver(), resolver = { ...video,
    async resolveMultiple(context) {
      calls.push({ action: 'multi', files: context.available.map(candidate => normalize(candidate.identityPath)), collectionType: sample.collectionType });
      return video.resolveMultiple(context);
    },
    async resolveDirectory(context) {
      calls.push({ action: 'resolve', path: normalize(context.candidate.identityPath) });
      return video.resolveDirectory(context);
    }
  };
  const folder = { id: 'native-folder-dispatch', priority: 1000, nativeTypes: { [folderNativeType]: { isFolder: true } },
    resolveDirectory({ candidate }) { calls.push({ action: 'folder', path: normalize(candidate.identityPath) }); return null; } };
  const pipeline = new DirectoryItemResolverPipeline({ resolvers: [resolver, folder], programDataPath: fixture.stateRoot, configuration: fixture.configuration });
  const result = await pipeline.resolve({ parent: loaded.parent, root: { Id: sample.aggregateParent ? loaded.parent.Id : '98c00000-0000-0000-0000-000000000099' },
    collectionContext: { collectionType: sample.collectionType }, candidates: await filterResolutionCandidates(candidates, coreOptions),
    peekDirectory, getExtraCandidates,
    resolveExtra: async ({ candidate }) => (await filterResolutionCandidates([candidate], { ...coreOptions, parent: null }))[0] ?? null });
  return result.claims.map(claim => createResolvedItemEntity(claim, { parent: loaded.parent,
    metadataConfiguration: { UseFileCreationTimeForDateAdded: !sample.useResolveTime }, clock: () => fixture.now }));
}

export function projectDirectoryItem(item, fixture, sample) {
  const normalize = value => value?.replace(fixture.stateRoot, '$STATE');
  // An existing file mutated to a disc enum still has its original file date.
  // The existing-child oracle normalizes only actual fresh directory resolves.
  const directoryVideo = item.IsFolder === false && ['Dvd', 'BluRay'].includes(item.VideoType)
    && !Object.hasOwn(sample.mutation ?? {}, 'VideoType');
  const dateCreated = item.IsFolder || directoryVideo || sample.useResolveTime ? '$UTC_RESOLVE' : dateText(item.DateCreated);
  if (dateCreated === '$UTC_RESOLVE') assert.equal(dateText(item.DateCreated), fixture.now, 'Resolve UTC must use the supplied candidate clock.');
  return { ...projectItem({ ...item, AdditionalParts: item.AdditionalParts ?? [] }, fixture.stateRoot),
    isFolder: item.IsFolder, mediaType: item.MediaType, providerIds: item.ProviderIds, video3DFormat: item.Video3DFormat ?? null,
    dateCreated, videoType: item.IsFolder ? null : item.VideoType,
    ...(sample.mutation ? { images: (item.ImageInfos ?? []).map(image => ({ path: normalize(image.Path), type: image.Type,
      dateModified: dateText(image.DateModified), width: image.Width, height: image.Height, blurHash: image.BlurHash ?? null })) } : {}),
    parts: item.IsFolder ? null : item.AdditionalParts.map(normalize),
    alternates: item.IsFolder ? null : item.LocalAlternateVersions.map(normalize) };
}

export async function projectDirectoryResolution(value, sample, resolved, exception = null) {
  const actual = await projectDiscovery(value.fixture, value.loaded, sample, { ...value, resolved: null, exception });
  actual.resolved = resolved.map(item => projectDirectoryItem(item, value.fixture, sample));
  return actual;
}
