import path from 'node:path';
import { getNewItemId } from '../core/identity.js';
import { StorageError, checkAbort } from '../storage/errors.js';
import { nativeGuid } from '../users/native.js';
import { nativeDirectoryName, nativePathKey, sameNativePath } from './native-path.js';

export const folderNativeType = 'MediaBrowser.Controller.Entities.Folder';
const folderFallbackResolverId = 'folder-fallback';

const keyFor = value => nativePathKey(value);
const pipelineInvariantErrors = new WeakSet();
const resolutionReadFailures = new WeakSet();
/** A builtin reader can bind a consistency failure to this resolution. Error
 * names or codes from an arbitrary resolver do not grant this propagation. */
export function preserveResolutionReadFailure(error) {
  resolutionReadFailures.add(error);
  return error;
}
const invalid = message => {
  const error = new StorageError('invalid-response', message);
  pipelineInvariantErrors.add(error);
  return error;
};
const librarySource = value => value == null || value === 0 || value === 'Library';
const relationshipFields = Object.freeze(['OwnerId', 'PrimaryVersionId', 'SeriesId', 'SeasonId']);
const ownershipFields = Object.freeze(['CanDelete', 'ExtraType']);
const localAlternateKeys = new Set(['primary', 'draft']);
const ownedPartKeys = new Set(['primary', 'nativeType', 'owner', 'draft']);
const ownedExtraKeys = new Set(['primary', 'nativeType', 'extraType', 'owner', 'draft']);

function candidatePath(value) {
  if (typeof value === 'string') return value;
  return value?.identityPath;
}

function directDirectoryChild(candidate, directory) {
  if (!['file', 'directory'].includes(candidate?.entry?.kind) || typeof candidate.identityPath !== 'string'
    || typeof candidate.accessPath !== 'string') return false;
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(candidate.identityPath);
  return sameNativePath(nativeDirectoryName(candidate.identityPath, { windows }), directory.identityPath)
    && path.posix.dirname(candidate.accessPath) === path.posix.normalize(directory.accessPath);
}

const directDirectoryMember = (candidate, directory) => candidate?.entry?.kind === 'file'
  && directDirectoryChild(candidate, directory);

function indexCandidates(candidates) {
  if (!Array.isArray(candidates)) throw invalid('The directory snapshot contains an invalid resolver candidate array.');
  const byPath = new Map();
  for (const candidate of candidates) {
    if (!candidate || !candidate.entry || !['file', 'directory'].includes(candidate.entry.kind)
      || typeof candidate.identityPath !== 'string' || typeof candidate.accessPath !== 'string') {
      throw invalid('The directory snapshot contains an invalid resolver candidate.');
    }
    const key = keyFor(candidate.identityPath);
    if (key === null) throw invalid('The directory snapshot contains an invalid resolver candidate path.');
    if (byPath.has(key)) throw invalid('The directory snapshot contains ambiguous resolver paths.');
    byPath.set(key, candidate);
  }
  return byPath;
}

function normalizeDraft(draft, resolver, nativeType) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.IsFolder !== 'boolean'
    || typeof draft.MediaType !== 'string' || !draft.MediaType) {
    throw invalid(`Directory item resolver ${resolver.id} returned an invalid item draft.`);
  }
  if (draft.Name != null && (typeof draft.Name !== 'string' || !draft.Name)) {
    throw invalid(`Directory item resolver ${resolver.id} returned an invalid item name.`);
  }
  for (const field of ['columns', 'initialColumns', 'data']) if (draft[field] != null
    && (typeof draft[field] !== 'object' || Array.isArray(draft[field]))) {
    throw invalid(`Directory item resolver ${resolver.id} returned invalid item draft ${field}.`);
  }
  if (Object.keys(draft.columns ?? {}).some(key => Object.hasOwn(draft.initialColumns ?? {}, key))) {
    throw invalid(`Directory item resolver ${resolver.id} returned overlapping persistent and initial columns.`);
  }
  if (!librarySource(draft.SourceType ?? draft.data?.SourceType)) {
    throw invalid(`Directory item resolver ${resolver.id} returned an unsupported item source type.`);
  }
  for (const field of relationshipFields) {
    if (Object.hasOwn(draft, field) || Object.hasOwn(draft.columns ?? {}, field)
      || Object.hasOwn(draft.initialColumns ?? {}, field)
      || Object.hasOwn(draft.data ?? {}, field)) {
      throw invalid(`Directory item resolver ${resolver.id} attempted to set unsupported relationship field ${field}.`);
    }
  }
  for (const field of ownershipFields) {
    if (Object.hasOwn(draft, field) || Object.hasOwn(draft.columns ?? {}, field)
      || Object.hasOwn(draft.initialColumns ?? {}, field)
      || Object.hasOwn(draft.data ?? {}, field)) {
      throw invalid(`Directory item resolver ${resolver.id} attempted to set scanner-owned field ${field}.`);
    }
  }
  const shape = resolver.declaredTypes.get(nativeType) ?? {};
  if (shape.isFolder !== undefined && draft.IsFolder !== shape.isFolder) {
    throw invalid(`Directory item resolver ${resolver.id} returned a draft with the wrong folder shape.`);
  }
  return Object.freeze({
    ...draft,
    ...(draft.columns == null ? {} : { columns: Object.freeze({ ...draft.columns }) }),
    ...(draft.initialColumns == null ? {} : { initialColumns: Object.freeze({ ...draft.initialColumns }) }),
    ...(draft.data == null ? {} : { data: Object.freeze({ ...draft.data }) })
  });
}

function nativeTypeShapes(resolver) {
  const values = resolver.nativeTypes ?? [];
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new TypeError('A directory resolver nativeTypes declaration is invalid.');
  }
  return Object.entries(values).map(([nativeType, shape]) => {
    if (shape == null || typeof shape !== 'object' || Array.isArray(shape) || typeof shape.isFolder !== 'boolean') {
      throw new TypeError(`Directory item resolver type ${nativeType} has an invalid shape.`);
    }
    return [nativeType, { ...shape }];
  });
}

function resolverPriority(resolver) {
  const priority = resolver.priority ?? 0;
  if (!Number.isFinite(priority)) throw new TypeError('A directory resolver priority must be finite.');
  return priority;
}

function normalizeResolvers(resolvers) {
  if (!Array.isArray(resolvers)) throw new TypeError('Directory item resolvers must be an array.');
  const ids = new Set();
  return resolvers.map((resolver, index) => {
    if (!resolver || typeof resolver !== 'object' || typeof resolver.id !== 'string' || !resolver.id) {
      throw new TypeError('Every directory item resolver requires a stable id.');
    }
    if (resolver.id === folderFallbackResolverId) {
      throw new TypeError(`Directory item resolver id ${folderFallbackResolverId} is reserved.`);
    }
    if (ids.has(resolver.id)) throw new TypeError(`Duplicate directory item resolver id: ${resolver.id}`);
    ids.add(resolver.id);
    const methods = ['resolveMultiple', 'resolveFile', 'resolveDirectory'].filter(name => typeof resolver[name] === 'function');
    if (!methods.length) throw new TypeError(`Directory item resolver ${resolver.id} has no resolver method.`);
    if (resolver.productionMediaScope != null
      && (typeof resolver.productionMediaScope !== 'string' || !resolver.productionMediaScope)) {
      throw new TypeError(`Directory item resolver ${resolver.id} has an invalid production media scope.`);
    }
    const declaredTypes = new Map(nativeTypeShapes(resolver));
    if (!declaredTypes.size) throw new TypeError(`Directory item resolver ${resolver.id} declares no native item type.`);
    return {
      id: resolver.id,
      priority: resolverPriority(resolver),
      declaredTypes,
      productionMediaScope: resolver.productionMediaScope ?? null,
      index,
      ...(typeof resolver.resolveMultiple === 'function' ? { resolveMultiple: resolver.resolveMultiple.bind(resolver) } : {}),
      ...(typeof resolver.resolveFile === 'function' ? { resolveFile: resolver.resolveFile.bind(resolver) } : {}),
      ...(typeof resolver.resolveDirectory === 'function' ? { resolveDirectory: resolver.resolveDirectory.bind(resolver) } : {})
    };
  }).sort((left, right) => left.priority - right.priority || left.index - right.index);
}

/**
 * Resolves one complete directory snapshot. Multi-item resolvers see every
 * sibling first. Without a multi winner, every sibling uses its respective
 * single-item chain. With a winner, only its explicit extraFiles do so. A
 * generic Folder is the final directory fallback for eligible directories.
 */
export class DirectoryItemResolverPipeline {
  #resolvers;
  #shapes = new Map([[folderNativeType, Object.freeze({ isFolder: true })]]);

  constructor(options = {}) {
    const { resolvers = [], programDataPath, configuration = {}, onError = () => {} } = options;
    if (typeof programDataPath !== 'string' || !programDataPath) {
      throw new TypeError('Directory item resolution requires the native program data path.');
    }
    this.#resolvers = normalizeResolvers(resolvers);
    for (const resolver of this.#resolvers) for (const [nativeType, shape = {}] of resolver.declaredTypes) {
      if (typeof nativeType !== 'string' || !nativeType) throw new TypeError(`Directory item resolver ${resolver.id} declares an invalid native type.`);
      const previous = this.#shapes.get(nativeType);
      if (previous && previous.isFolder !== undefined && shape?.isFolder !== undefined
        && previous.isFolder !== shape.isFolder) {
        throw new TypeError(`Directory item resolver type ${nativeType} has conflicting shapes.`);
      }
      this.#shapes.set(nativeType, Object.freeze({ ...previous, ...shape }));
    }
    this.programDataPath = programDataPath;
    if (typeof onError !== 'function') throw new TypeError('Directory item resolver error reporting must be a function.');
    this.onError = onError;
    if (configuration === null) throw new TypeError('Directory item resolution requires configuration.');
    this.options = options;
    this.nativeTypes = Object.freeze([...this.#shapes.keys()]);
    const productionMediaScopes = this.#resolvers.map(resolver => resolver.productionMediaScope).filter(Boolean);
    this.capabilities = Object.freeze({
      resolvesProductionMediaFiles: productionMediaScopes.length > 0,
      productionMediaScopes: Object.freeze(productionMediaScopes)
    });
  }

  get configuration() { const { configuration = {} } = this.options; return configuration; }

  manages(item) {
    const nativeType = item?.NativeType ?? item?.nativeType ?? item?.Type;
    const shape = this.#shapes.get(nativeType);
    return Boolean(shape) && (shape.isFolder === undefined || item?.IsFolder === shape.isFolder);
  }

  #id(identityKey, nativeType) {
    return nativeGuid(getNewItemId(identityKey, nativeType, {
      programDataPath: this.programDataPath,
      enableCaseSensitiveItemIds: this.configuration.EnableCaseSensitiveItemIds === true
    }));
  }

  #claim(raw, resolver, state, current, allowedPaths = null) {
    if (!raw || typeof raw !== 'object') throw invalid(`Directory item resolver ${resolver.id} returned an invalid claim.`);
    const nativeType = raw.nativeType;
    if (!resolver.declaredTypes.has(nativeType)) {
      throw invalid(`Directory item resolver ${resolver.id} returned undeclared native type ${nativeType ?? '<empty>'}.`);
    }
    const primaryPath = candidatePath(raw.primary);
    const primary = state.byPath.get(keyFor(primaryPath));
    if (!primary || !primaryPath || !sameNativePath(primary.identityPath, primaryPath)) {
      throw invalid(`Directory item resolver ${resolver.id} returned a primary outside the sibling snapshot.`);
    }
    if (Object.hasOwn(raw, 'identityKey')) {
      throw invalid(`Directory item resolver ${resolver.id} returned an unsupported identity key override.`);
    }
    if (Object.hasOwn(raw, 'replacementPaths')) {
      throw invalid(`Directory item resolver ${resolver.id} returned an unsupported replacement path override.`);
    }
    let itemSource = primary;
    let nestedDirectorySource = false;
    const bookDirectorySource = nativeType === 'MediaBrowser.Controller.Entities.Book'
      && raw.itemSource?.entry?.kind === 'directory';
    const replacementPaths = [];
    if (Object.hasOwn(raw, 'itemSource')) {
      const provenance = raw.itemSource && typeof raw.itemSource === 'object'
        ? state.primaryPeekedCandidates.get(raw.itemSource) : null;
      const directorySource = raw.itemSource?.entry?.kind === 'directory';
      const directMember = directorySource
        ? directDirectoryChild(raw.itemSource, primary) : directDirectoryMember(raw.itemSource, primary);
      if (!current || current !== primary || primary.entry.kind !== 'directory'
        || !provenance || provenance.parent !== primary) {
        throw invalid(`Directory item resolver ${resolver.id} returned an item source outside the primary directory snapshot.`);
      }
      if (!provenance.deletionSafe) {
        throw invalid(`Directory item resolver ${resolver.id} returned an item source from a weak directory snapshot.`);
      }
      if (!directMember || directorySource && !bookDirectorySource
        && (!Array.isArray(raw.directoryParts) || raw.directoryParts.length === 0)) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid item source.`);
      }
      itemSource = raw.itemSource;
      nestedDirectorySource = directorySource;
      replacementPaths.push(primary.identityPath);
    }
    if (nestedDirectorySource && ['localAlternates', 'ownedParts', 'ownedExtras', 'ownedExtraScopes']
      .some(key => Object.hasOwn(raw, key))) {
      throw invalid(`Directory item resolver ${resolver.id} returned an invalid multi-disc directory claim.`);
    }
    const paths = raw.consumedPaths;
    if (!Array.isArray(paths) || !paths.length) {
      throw invalid(`Directory item resolver ${resolver.id} must return a nonempty consumedPaths array.`);
    }
    const claimed = [];
    const claimedCandidates = new Map();
    const local = new Set();
    for (const value of paths) {
      const path = candidatePath(value);
      const key = keyFor(path);
      let candidate = state.byPath.get(key);
      const provenance = value && typeof value === 'object' ? state.primaryPeekedCandidates.get(value) : null;
      const declaredDirectoryMember = nestedDirectorySource && (value === itemSource
        || Array.isArray(raw.directoryParts) && raw.directoryParts.includes(value));
      const nested = !candidate && itemSource !== primary && provenance?.parent === primary
        && provenance.deletionSafe && (nestedDirectorySource
          ? declaredDirectoryMember && directDirectoryChild(value, primary)
          : directDirectoryMember(value, primary));
      if (nested) candidate = value;
      if (!candidate) throw invalid(`Directory item resolver ${resolver.id} claimed a path outside the sibling snapshot.`);
      if (allowedPaths && !allowedPaths.has(key) && !nested) {
        throw invalid(`Directory item resolver ${resolver.id} claimed a path outside the single-item handoff.`);
      }
      if (local.has(key) || state.consumedPaths.has(key)) {
        throw invalid(`Directory item resolver ${resolver.id} returned an overlapping sibling claim.`);
      }
      if (state.withheldPaths.has(key)) {
        throw invalid(`Directory item resolver ${resolver.id} attempted to claim a withheld sibling path.`);
      }
      local.add(key);
      claimedCandidates.set(key, candidate);
      claimed.push(candidate.identityPath);
    }
    const primaryKey = keyFor(primary.identityPath);
    if (!local.has(primaryKey)) throw invalid(`Directory item resolver ${resolver.id} did not consume its primary path.`);
    if (current && !local.has(keyFor(current.identityPath))) {
      throw invalid(`Directory item resolver ${resolver.id} did not consume the candidate it resolved.`);
    }
    const normalizedDraft = normalizeDraft(raw.draft, resolver, nativeType);
    const traversal = raw.traversal ?? 'none';
    if (!['none', 'children'].includes(traversal) || traversal === 'children' && !normalizedDraft.IsFolder) {
      throw invalid(`Directory item resolver ${resolver.id} returned an invalid traversal mode.`);
    }
    if (itemSource !== primary && (normalizedDraft.IsFolder || traversal !== 'none')) {
      throw invalid(`Directory item resolver ${resolver.id} returned an invalid nested item shape.`);
    }
    if (itemSource !== primary && itemSource?.entry?.kind === 'directory'
      && !bookDirectorySource && !['Dvd', 'BluRay'].includes(normalizedDraft.data?.VideoType)) {
      throw invalid(`Directory item resolver ${resolver.id} returned an unsupported directory item source.`);
    }
    const Id = this.#id(itemSource.identityPath, nativeType);
    if (state.itemIds.has(String(Id).replaceAll('-', '').toLowerCase())) {
      throw invalid(`Directory item resolver ${resolver.id} returned a duplicate deterministic item identity.`);
    }
    const ownsLocalAlternates = Object.hasOwn(raw, 'localAlternates');
    const rawAlternates = ownsLocalAlternates ? raw.localAlternates : [];
    if (!Array.isArray(rawAlternates) || rawAlternates.length && (normalizedDraft.IsFolder || traversal !== 'none')) {
      throw invalid(`Directory item resolver ${resolver.id} returned invalid local alternate versions.`);
    }
    const localAlternates = [];
    const alternateKeys = new Set();
    const pendingIds = new Set([String(Id).replaceAll('-', '').toLowerCase()]);
    for (const alternate of rawAlternates) {
      if (!alternate || typeof alternate !== 'object' || Array.isArray(alternate)
        || Object.keys(alternate).some(key => !localAlternateKeys.has(key))) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid local alternate version.`);
      }
      const alternatePath = candidatePath(alternate.primary);
      const alternateKey = keyFor(alternatePath);
      const alternateCandidate = claimedCandidates.get(alternateKey);
      if (!alternateCandidate || alternateCandidate.entry?.kind !== 'file'
        || !local.has(alternateKey) || alternateKey === primaryKey || alternateKeys.has(alternateKey)) {
        throw invalid(`Directory item resolver ${resolver.id} returned a local alternate outside its consumed sibling claim.`);
      }
      const alternateDraft = normalizeDraft(alternate.draft, resolver, nativeType);
      if (alternateDraft.IsFolder) {
        throw invalid(`Directory item resolver ${resolver.id} returned a folder as a local alternate version.`);
      }
      const alternateId = this.#id(alternateCandidate.identityPath, nativeType);
      const alternateIdKey = String(alternateId).replaceAll('-', '').toLowerCase();
      if (state.itemIds.has(alternateIdKey) || pendingIds.has(alternateIdKey)) {
        throw invalid(`Directory item resolver ${resolver.id} returned a duplicate deterministic item identity.`);
      }
      pendingIds.add(alternateIdKey);
      alternateKeys.add(alternateKey);
      localAlternates.push(Object.freeze({
        Id: alternateId,
        resolverId: resolver.id,
        nativeType,
        identityPath: alternateCandidate.identityPath,
        accessPath: alternateCandidate.accessPath,
        entry: alternateCandidate.entry,
        primary: alternateCandidate,
        consumedPaths: Object.freeze([alternateCandidate.identityPath]),
        replacementPaths: Object.freeze([]),
        traversal: 'none',
        draft: alternateDraft
      }));
    }
    const declaredAlternatePaths = normalizedDraft.data?.LocalAlternateVersions ?? [];
    if (ownsLocalAlternates && (!Array.isArray(declaredAlternatePaths)
      || declaredAlternatePaths.length !== localAlternates.length
      || declaredAlternatePaths.some((value, index) => !sameNativePath(value, localAlternates[index].identityPath)))) {
      throw invalid(`Directory item resolver ${resolver.id} returned inconsistent local alternate version paths.`);
    }
    const ownerTargets = new Map([[keyFor(itemSource.identityPath), Id]]);
    for (const alternate of localAlternates) ownerTargets.set(keyFor(alternate.identityPath), alternate.Id);
    const ownsOwnedParts = Object.hasOwn(raw, 'ownedParts');
    const rawParts = ownsOwnedParts ? raw.ownedParts : [];
    if (!Array.isArray(rawParts) || rawParts.length && (normalizedDraft.IsFolder || traversal !== 'none')) {
      throw invalid(`Directory item resolver ${resolver.id} returned invalid owned parts.`);
    }
    const ownedParts = [];
    const partPaths = new Set();
    for (const part of rawParts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)
        || Object.keys(part).some(key => !ownedPartKeys.has(key))) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid owned part.`);
      }
      const partNativeType = part.nativeType;
      if (!resolver.declaredTypes.has(partNativeType)) {
        throw invalid(`Directory item resolver ${resolver.id} returned undeclared owned part type ${partNativeType ?? '<empty>'}.`);
      }
      const partPath = candidatePath(part.primary), partKey = keyFor(partPath);
      const partCandidate = claimedCandidates.get(partKey), ownerId = ownerTargets.get(keyFor(candidatePath(part.owner)));
      if (!partCandidate || !sameNativePath(partCandidate.identityPath, partPath)
        || partCandidate.entry?.kind !== 'file' || !local.has(partKey) || !ownerId || partPaths.has(partKey)
        || sameNativePath(partPath, itemSource.identityPath)
        || localAlternates.some(alternate => sameNativePath(alternate.identityPath, partPath))) {
        throw invalid(`Directory item resolver ${resolver.id} returned an owned part outside its consumed claim.`);
      }
      const partDraft = normalizeDraft(part.draft, resolver, partNativeType);
      if (partDraft.IsFolder) throw invalid(`Directory item resolver ${resolver.id} returned a folder as an owned part.`);
      const partId = this.#id(partCandidate.identityPath, partNativeType);
      const partIdKey = String(partId).replaceAll('-', '').toLowerCase();
      if (state.itemIds.has(partIdKey) || pendingIds.has(partIdKey)) {
        throw invalid(`Directory item resolver ${resolver.id} returned a duplicate deterministic item identity.`);
      }
      pendingIds.add(partIdKey);
      partPaths.add(partKey);
      ownedParts.push(Object.freeze({
        Id: partId,
        resolverId: resolver.id,
        nativeType: partNativeType,
        identityPath: partCandidate.identityPath,
        accessPath: partCandidate.accessPath,
        entry: partCandidate.entry,
        primary: partCandidate,
        consumedPaths: Object.freeze([partCandidate.identityPath]),
        replacementPaths: Object.freeze([]),
        traversal: 'none',
        draft: partDraft,
        ownerId
      }));
    }
    const rawDirectoryParts = raw.directoryParts ?? [];
    if (!Array.isArray(rawDirectoryParts) || rawDirectoryParts.length
      && (normalizedDraft.IsFolder || traversal !== 'none')) {
      throw invalid(`Directory item resolver ${resolver.id} returned invalid directory parts.`);
    }
    const directoryParts = [];
    const directoryPartPaths = new Set();
    for (const part of rawDirectoryParts) {
      const partPath = candidatePath(part), partKey = keyFor(partPath);
      const partCandidate = claimedCandidates.get(partKey);
      const provenance = part && typeof part === 'object' ? state.primaryPeekedCandidates.get(part) : null;
      if (!partCandidate || partCandidate.entry?.kind !== 'directory' || !local.has(partKey)
        || partKey === keyFor(itemSource.identityPath) || partPaths.has(partKey) || directoryPartPaths.has(partKey)
        || !provenance || provenance.parent !== primary || !provenance.deletionSafe
        || !directDirectoryChild(partCandidate, primary)) {
        throw invalid(`Directory item resolver ${resolver.id} returned a directory part outside its consumed claim.`);
      }
      directoryPartPaths.add(partKey);
      directoryParts.push(Object.freeze({
        identityPath: partCandidate.identityPath,
        accessPath: partCandidate.accessPath,
        entry: partCandidate.entry
      }));
    }
    if (nestedDirectorySource && (bookDirectorySource
      ? local.size !== 2 || directoryParts.length !== 0
      : local.size !== directoryParts.length + 2 || directoryParts.length === 0)) {
      throw invalid(`Directory item resolver ${resolver.id} returned an invalid multi-disc directory claim.`);
    }
    for (const owner of [{ Id, draft: normalizedDraft }, ...localAlternates]) {
      const declared = owner.draft.data?.AdditionalParts ?? [];
      const ownerIdKey = String(owner.Id).replaceAll('-', '').toLowerCase();
      const actual = ownedParts.filter(part => String(part.ownerId).replaceAll('-', '').toLowerCase() === ownerIdKey)
        .map(part => part.identityPath);
      if (owner.Id === Id) actual.push(...directoryParts.map(part => part.identityPath));
      if (!Array.isArray(declared) || declared.length !== actual.length
        || declared.some((value, index) => !sameNativePath(value, actual[index]))) {
        throw invalid(`Directory item resolver ${resolver.id} returned inconsistent additional-part paths.`);
      }
    }
    const ownsOwnedExtras = Object.hasOwn(raw, 'ownedExtras');
    const rawExtras = ownsOwnedExtras ? raw.ownedExtras : [];
    const rawExtraScopes = raw.ownedExtraScopes ?? [];
    if (!Array.isArray(rawExtras) || !Array.isArray(rawExtraScopes)
      || !ownsOwnedExtras && Object.hasOwn(raw, 'ownedExtraScopes')
      || rawExtras.length && (normalizedDraft.IsFolder || traversal !== 'none')) {
      throw invalid(`Directory item resolver ${resolver.id} returned invalid owned extras.`);
    }
    let ownedExtrasDeletionSafe = state.deletionSafe;
    const nestedCandidate = value => {
      const requestedPath = candidatePath(value), direct = state.byPath.get(keyFor(requestedPath)) ?? state.extraByPath.get(keyFor(requestedPath));
      if (direct && sameNativePath(direct.identityPath, requestedPath)) {
        return { candidate: direct, anchor: direct, deletionSafe: state.extraByPath.has(keyFor(requestedPath)) ? state.extraDeletionSafe : true };
      }
      if (!value || typeof value !== 'object') return null;
      let current = value, deletionSafe = true;
      const visited = new Set();
      while (current && typeof current === 'object' && !visited.has(current)) {
        visited.add(current);
        const provenance = state.peekedCandidates.get(current);
        if (!provenance) return null;
        deletionSafe &&= provenance.deletionSafe;
        const parentPath = candidatePath(provenance.parent);
        const anchor = state.byPath.get(keyFor(parentPath)) ?? state.extraByPath.get(keyFor(parentPath));
        if (anchor && sameNativePath(anchor.identityPath, parentPath)) {
          if (state.extraByPath.has(keyFor(parentPath))) deletionSafe &&= state.extraDeletionSafe;
          return { candidate: value, anchor, deletionSafe };
        }
        current = provenance.parent;
      }
      return null;
    };
    const ownsExtraAnchor = resolved => local.has(keyFor(resolved.anchor.identityPath))
      || !state.byPath.has(keyFor(resolved.anchor.identityPath))
        && state.extraByPath.get(keyFor(resolved.anchor.identityPath)) === resolved.anchor;
    const scopeKeys = new Set();
    for (const scope of rawExtraScopes) {
      const resolved = nestedCandidate(scope), scopePath = candidatePath(scope), scopeKey = keyFor(scopePath);
      const snapshot = scope && typeof scope === 'object' ? state.peekedDirectories.get(scope) : null;
      if (!resolved || scope?.entry?.kind !== 'directory' || !snapshot
        || !ownsExtraAnchor(resolved) || scopeKeys.has(scopeKey)) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid owned-extra scope.`);
      }
      scopeKeys.add(scopeKey);
      ownedExtrasDeletionSafe &&= resolved.deletionSafe && snapshot.deletionSafe;
    }
    const ownedExtras = [];
    const extraPaths = new Set();
    for (const extra of rawExtras) {
      if (!extra || typeof extra !== 'object' || Array.isArray(extra)
        || Object.keys(extra).some(key => !ownedExtraKeys.has(key))) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid owned extra.`);
      }
      const extraType = extra.extraType;
      if (!Number.isInteger(extraType) || extraType < 0 || extraType > 11) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid owned extra type.`);
      }
      const extraNativeType = extra.nativeType;
      if (!resolver.declaredTypes.has(extraNativeType)) {
        throw invalid(`Directory item resolver ${resolver.id} returned undeclared owned extra type ${extraNativeType ?? '<empty>'}.`);
      }
      const resolved = nestedCandidate(extra.primary), extraPath = candidatePath(extra.primary);
      const extraKey = keyFor(extraPath), ownerId = ownerTargets.get(keyFor(candidatePath(extra.owner)));
      if (!resolved || extra.primary?.entry?.kind !== 'file' || !ownsExtraAnchor(resolved)
        || !ownerId || extraPaths.has(extraKey) || partPaths.has(extraKey) || sameNativePath(extraPath, itemSource.identityPath)
        || localAlternates.some(alternate => sameNativePath(alternate.identityPath, extraPath))) {
        throw invalid(`Directory item resolver ${resolver.id} returned an owned extra outside its consumed claim.`);
      }
      const extraDraft = normalizeDraft(extra.draft, resolver, extraNativeType);
      if (extraDraft.IsFolder) throw invalid(`Directory item resolver ${resolver.id} returned a folder as an owned extra.`);
      const extraId = this.#id(extra.primary.identityPath, extraNativeType);
      const extraIdKey = String(extraId).replaceAll('-', '').toLowerCase();
      if (state.itemIds.has(extraIdKey) || pendingIds.has(extraIdKey)) {
        throw invalid(`Directory item resolver ${resolver.id} returned a duplicate deterministic item identity.`);
      }
      pendingIds.add(extraIdKey);
      extraPaths.add(extraKey);
      ownedExtrasDeletionSafe &&= resolved.deletionSafe;
      ownedExtras.push(Object.freeze({
        Id: extraId,
        resolverId: resolver.id,
        nativeType: extraNativeType,
        identityPath: extra.primary.identityPath,
        accessPath: extra.primary.accessPath,
        entry: extra.primary.entry,
        primary: extra.primary,
        consumedPaths: Object.freeze([extra.primary.identityPath]),
        replacementPaths: Object.freeze([]),
        traversal: 'none',
        draft: extraDraft,
        ownerId,
        extraType
      }));
    }
    const claim = Object.freeze({
      Id,
      resolverId: resolver.id,
      nativeType,
      identityPath: itemSource.identityPath,
      accessPath: itemSource.accessPath,
      entry: itemSource.entry,
      primary,
      consumedPaths: Object.freeze(claimed),
      replacementPaths: Object.freeze(replacementPaths),
      traversal,
      draft: normalizedDraft,
      localAlternates: Object.freeze(localAlternates),
      ownsLocalAlternates,
      ownedParts: Object.freeze(ownedParts),
      ownsOwnedParts,
      ownedPartsDeletionSafe: state.deletionSafe,
      directoryParts: Object.freeze(directoryParts),
      ownedExtras: Object.freeze(ownedExtras),
      ownsOwnedExtras,
      ownedExtrasDeletionSafe
    });
    for (const itemId of pendingIds) state.itemIds.add(itemId);
    state.claims.push(claim);
    for (const key of local) state.consumedPaths.set(key, claim);
    return claim;
  }

  #report(error, resolver, method) {
    try { void Promise.resolve(this.onError(error, { resolverId: resolver.id, method })).catch(() => {}); }
    catch { /* Resolver diagnostics cannot replace native fallback behavior. */ }
  }

  async #call(resolver, method, context, signal, { continueOnError = false } = {}) {
    checkAbort(signal);
    let result;
    try { result = await resolver[method](context); }
    catch (error) {
      checkAbort(signal);
      if (!continueOnError || pipelineInvariantErrors.has(error) || resolutionReadFailures.has(error)) throw error;
      this.#report(error, resolver, method);
      return null;
    }
    checkAbort(signal);
    return result;
  }

  async resolvePath({ candidate, ...options } = {}) {
    const resolved = await this.resolve({ ...options, candidates: [candidate], singleItem: true });
    return resolved.claims.find(claim => claim.primary === candidate) ?? null;
  }

  async resolve({ parent, root, collectionContext = null, candidates, peekDirectory, getExtraCandidates, resolveExtra,
    onEnumerationReady, deletionSafe = true, singleItem = false, signal } = {}) {
    if (!Array.isArray(candidates)) throw new TypeError('Directory resolution requires a sibling candidate array.');
    if (peekDirectory != null && typeof peekDirectory !== 'function') throw new TypeError('peekDirectory must be a function.');
    if (getExtraCandidates != null && typeof getExtraCandidates !== 'function') throw new TypeError('getExtraCandidates must be a function.');
    if (resolveExtra != null && typeof resolveExtra !== 'function') throw new TypeError('resolveExtra must be a function.');
    if (onEnumerationReady != null && typeof onEnumerationReady !== 'function') throw new TypeError('onEnumerationReady must be a function.');
    if (typeof deletionSafe !== 'boolean') throw new TypeError('Directory resolution deletionSafe must be a boolean.');
    checkAbort(signal);
    const byPath = indexCandidates(candidates);
    const ordered = [...candidates];
    const state = { byPath, claims: [], consumedPaths: new Map(), withheldPaths: new Set(), itemIds: new Set(),
      peekedCandidates: new WeakMap(), primaryPeekedCandidates: new WeakMap(), peekedDirectories: new WeakMap(),
      extraByPath: new Map(), extraDeletionSafe: deletionSafe, deletionSafe };
    const unavailable = candidate => state.consumedPaths.has(keyFor(candidate.identityPath))
      || state.withheldPaths.has(keyFor(candidate.identityPath));
    const available = () => ordered.filter(candidate => !unavailable(candidate));
    const recordPeek = (candidate, snapshot, { primary = false } = {}) => {
      if (candidate && typeof candidate === 'object') state.peekedDirectories.set(candidate, {
        deletionSafe: snapshot?.listing?.deletionSafe === true
      });
      if (Array.isArray(snapshot?.candidates)) for (const child of snapshot.candidates) {
        if (!child || typeof child !== 'object') continue;
        const previous = state.peekedCandidates.get(child);
        if (previous && previous.parent !== candidate) {
          throw invalid('A directory peek returned one candidate from multiple parent snapshots.');
        }
        const provenance = {
          parent: candidate,
          deletionSafe: snapshot.listing?.deletionSafe === true
        };
        state.peekedCandidates.set(child, provenance);
        // Extra-only observations can establish secondary ownership, but they
        // cannot promote a Core-filtered file into a collapsed primary item.
        if (primary) state.primaryPeekedCandidates.set(child, provenance);
      }
      return snapshot;
    };
    const primarySnapshots = new WeakMap();
    const resolverPeekDirectory = peekDirectory == null ? undefined : (candidate, options) => {
      const primary = options?.forExtras !== true;
      const cacheable = options == null || Reflect.ownKeys(options).length === 0;
      if (cacheable && primarySnapshots.has(candidate)) return primarySnapshots.get(candidate);
      const pending = (async () => {
        const snapshot = await peekDirectory(candidate, options); checkAbort(signal);
        return recordPeek(candidate, snapshot, { primary });
      })();
      if (cacheable) {
        primarySnapshots.set(candidate, pending);
        void pending.catch(() => {
          if (primarySnapshots.get(candidate) === pending) primarySnapshots.delete(candidate);
        });
      }
      return pending;
    };
    const resolverExtraCandidates = getExtraCandidates == null ? undefined : async candidate => {
      if (candidate != null && (candidate.entry?.kind !== 'directory'
        || byPath.get(keyFor(candidate.identityPath)) !== candidate && !state.peekedCandidates.has(candidate)
          && state.extraByPath.get(keyFor(candidate.identityPath)) !== candidate)) {
        throw invalid('An owned-extra snapshot was requested outside the directory observations.');
      }
      const snapshot = await getExtraCandidates(candidate); checkAbort(signal);
      const extraByPath = indexCandidates(snapshot?.candidates);
      if (candidate != null) recordPeek(candidate, snapshot);
      else {
        for (const [key, extra] of extraByPath) if (byPath.has(key) && byPath.get(key) !== extra) {
          throw invalid('Owned-extra and resolver observations disagree about a sibling.');
        }
        state.extraByPath = extraByPath;
        state.extraDeletionSafe &&= snapshot.listing?.deletionSafe === true;
      }
      return snapshot.candidates;
    };
    const base = { parent, root, collectionContext, candidates: ordered, available, deletionSafe,
      peekDirectory: resolverPeekDirectory, getExtraCandidates: resolverExtraCandidates, resolveExtra, signal };
    let singleCandidates = ordered, multiItemWinner = false;

    for (const resolver of this.#resolvers.filter(value => !singleItem && typeof value.resolveMultiple === 'function')) {
      const result = await this.#call(resolver, 'resolveMultiple', { ...base, available: available() }, signal);
      if (result == null) continue;
      if (typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).some(key => !['items', 'extraFiles'].includes(key))
        || !Array.isArray(result.items) || !Array.isArray(result.extraFiles)) {
        throw invalid(`Directory item resolver ${resolver.id} returned an invalid multi-item result.`);
      }
      const items = result.items;
      if (!items.length) {
        if (result.extraFiles.length) {
          throw invalid(`Directory item resolver ${resolver.id} returned extra files without a multi-item winner.`);
        }
        continue;
      }
      for (const item of items) this.#claim(item, resolver, state);
      const extraKeys = new Set();
      for (const value of result.extraFiles) {
        const path = candidatePath(value);
        const key = keyFor(path);
        const candidate = state.byPath.get(key);
        if (!candidate) {
          throw invalid(`Directory item resolver ${resolver.id} returned an extra file outside the sibling snapshot.`);
        }
        if (extraKeys.has(key)) {
          throw invalid(`Directory item resolver ${resolver.id} returned a duplicate extra file.`);
        }
        if (state.consumedPaths.has(key)) {
          throw invalid(`Directory item resolver ${resolver.id} returned an extra file already consumed by its winner.`);
        }
        extraKeys.add(key);
      }
      // A winning multi resolver owns the complete sibling handoff. Paths it
      // neither consumes nor explicitly returns as extras are intentionally
      // suppressed, so surface them as withheld for incremental reconciliation
      // instead of silently preserving an older managed row at that path.
      for (const candidate of ordered) {
        const key = keyFor(candidate.identityPath);
        if (!state.consumedPaths.has(key) && !extraKeys.has(key)) state.withheldPaths.add(key);
      }
      singleCandidates = result.extraFiles.map(value => byPath.get(keyFor(candidatePath(value))));
      multiItemWinner = true;
      break;
    }

    const passedToSingle = singleCandidates.map(candidate => candidate.identityPath);
    const singleKeys = new Set(singleCandidates.map(candidate => keyFor(candidate.identityPath)));
    const folderResolver = { id: folderFallbackResolverId, declaredTypes: new Map([[folderNativeType, { isFolder: true }]]) };
    const singleResults = new Map();
    const resolveSingleItem = async (candidate, limit) => {
      if (unavailable(candidate)) return;
      const method = candidate.entry.kind === 'file' ? 'resolveFile' : 'resolveDirectory';
      let results = singleResults.get(candidate);
      if (!results) singleResults.set(candidate, results = new Map());
      for (let index = 0; index < limit; index++) {
        if (unavailable(candidate)) return;
        const resolver = this.#resolvers[index];
        if (typeof resolver[method] !== 'function') continue;
        if (!results.has(index)) results.set(index, await this.#call(resolver, method, { ...base, candidate,
          available: singleCandidates.filter(value => !unavailable(value)) }, signal,
        { continueOnError: true }));
        const result = results.get(index);
        if (result == null) continue;
        if (Object.hasOwn(result, 'withhold')) {
          if (typeof result !== 'object' || Array.isArray(result)
            || result.withhold !== true || Reflect.ownKeys(result).length !== 1) {
            throw invalid(`Directory item resolver ${resolver.id} returned an invalid withhold result.`);
          }
          state.withheldPaths.add(keyFor(candidate.identityPath));
          return;
        }
        // A single plugin may consume sibling observations. Before accepting
        // that claim, honor higher-priority results for those siblings once.
        // Ordinary native claims resolve one item and its Folder fallback
        // immediately, preserving ResolveFileList order and exception timing.
        for (const value of Array.isArray(result.consumedPaths) ? result.consumedPaths : []) {
          const sibling = byPath.get(keyFor(candidatePath(value)));
          if (sibling && sibling !== candidate && singleKeys.has(keyFor(sibling.identityPath))) await resolveSingle(sibling, index);
        }
        this.#claim(result, resolver, state, candidate, singleKeys);
        return;
      }
      checkAbort(signal);
      if (limit === this.#resolvers.length && candidate.entry.kind === 'directory' && !unavailable(candidate)) this.#claim({
        nativeType: folderNativeType, primary: candidate, consumedPaths: [candidate], traversal: 'children',
        draft: { Name: candidate.entry.name, IsFolder: true, MediaType: 'Unknown', SourceType: 'Library' }
      }, folderResolver, state, candidate, singleKeys);
    };
    const failedSingles = new WeakSet();
    const resolveSingle = async (candidate, limit = this.#resolvers.length) => {
      checkAbort(signal);
      if (unavailable(candidate) || failedSingles.has(candidate)) return;
      if (candidate.entry.kind === 'directory' && resolverPeekDirectory) {
        try {
          // ResolvePath gathers the candidate's children before invoking any
          // concrete resolver. Resolvers share that initial observation.
          await resolverPeekDirectory(candidate);
        } catch (error) {
          checkAbort(signal);
          if (pipelineInvariantErrors.has(error)) throw error;
          // ResolveFileList skips this path while retaining sibling results.
          // Reads made later inside a resolver use its own recovery boundary.
          this.#report(error, { id: 'path-resolution' }, 'resolvePath');
          if (parent?.IsPhysicalRoot !== true) {
            failedSingles.add(candidate);
            return;
          }
          // ResolvePath treats an unreadable child of the physical root as
          // an empty directory and still invokes its concrete resolvers.
          const snapshot = recordPeek(candidate, { listing: { deletionSafe: true }, candidates: [] }, { primary: true });
          primarySnapshots.set(candidate, Promise.resolve(snapshot));
        }
      }
      checkAbort(signal);
      await resolveSingleItem(candidate, limit);
    };
    // ResolvePaths returns a lazy single-item sequence, while a multi-item
    // winner eagerly resolves its extras before returning the completed list.
    if (!multiItemWinner) onEnumerationReady?.();
    for (const candidate of singleCandidates) await resolveSingle(candidate);
    if (multiItemWinner) onEnumerationReady?.();

    const unclaimedPaths = ordered.filter(candidate => !state.consumedPaths.has(keyFor(candidate.identityPath)))
      .map(candidate => candidate.identityPath);
    return Object.freeze({
      claims: Object.freeze(state.claims),
      consumedPaths: state.consumedPaths,
      withheldPaths: Object.freeze(ordered.filter(candidate => state.withheldPaths.has(keyFor(candidate.identityPath)))
        .map(candidate => candidate.identityPath)),
      passedToSingle: Object.freeze(passedToSingle),
      unclaimedPaths: Object.freeze(unclaimedPaths)
    });
  }
}
