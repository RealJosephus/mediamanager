import path from 'node:path';
import { MIN_DATE, VIDEO_TYPES, dateText, idKey, sameId } from './records.js';
import { nativeGuid } from '../users/native.js';
import { nativeContainingFolderPath, sameNativePath } from './native-path.js';
import { collectOwnedExtras } from './video-file-resolver.js';
import { audioNativeType } from './audio-item-resolver.js';
import { applyNativeItemValues, cloneNativeItemEntity, newNativeItemEntity } from './native-item-entity.js';
import { DotIgnoreRule } from './dot-ignore-rule.js';
import { shouldIgnoreResolutionCandidate } from './resolution-ignore.js';

const extraTypes = ['Unknown', 'Clip', 'Trailer', 'BehindTheScenes', 'DeletedScene', 'Interview', 'Scene', 'Sample',
  'ThemeSong', 'ThemeVideo', 'Featurette', 'Short'];
const apiFor = value => /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? path.win32 : path.posix;
const conflict = message => Object.assign(new Error(message), { code: 'metadata-conflict', status: 409 });

export function resolveOwnedExtraFile(candidate, { nativeType, draft }) {
  const item = newNativeItemEntity(nativeType);
  return applyNativeItemValues(item, { Path: candidate.identityPath, Name: draft.Name },
    draft.columns, draft.initialColumns, draft.data);
}

/** FindExtras resolves live entities; its first provider save creates new rows. */
export class OwnedExtraDiscovery {
  constructor({ vfs, identityMap, files, ignoreRule = new DotIgnoreRule({ vfs, identityMap }), resolveFile = resolveOwnedExtraFile }) {
    Object.assign(this, { ignoreRule, resolveFile });
    this.files = files ?? {
      async list(identityPath) {
        const api = apiFor(identityPath);
        const accessPath = identityMap.resolve({ identityPath, style: api === path.win32 ? 'windows' : 'posix' });
        return { ...await vfs.list(accessPath), accessPath };
      },
      stat: candidate => vfs.stat(candidate.accessPath),
    };
  }

  async find(loaded, state, { preview = false } = {}) {
    const owner = loaded.item, folder = nativeContainingFolderPath(owner), api = apiFor(folder);
    const ignoreRule = preview ? this.ignoreRule.clone() : this.ignoreRule;
    if (!['VideoFile', 'Iso'].includes(owner.VideoType ?? 'VideoFile')) {
      throw Object.assign(new Error('Owned extra discovery requires an ordinary file or folder owner.'), { status: 501 });
    }
    const candidateFor = (identityPath, entry, accessPath) => ({ identityPath, entry, accessPath });
    const snapshots = [];
    const list = async identityPath => {
      const snapshot = await this.files.list(identityPath), accessPath = snapshot.accessPath;
      snapshots.push(snapshot);
      return { ...snapshot, candidates: snapshot.entries.map(entry => candidateFor(api.join(identityPath, entry.name), entry,
        accessPath ? path.posix.join(accessPath, entry.name) : undefined)) };
    };
    const children = await list(folder), candidates = [];
    for (const candidate of children.candidates) if (!await ignoreRule.shouldIgnore(candidate.identityPath, {
      isDirectory: candidate.entry.kind === 'directory'
    })) candidates.push(candidate);
    const ownerCandidate = { ...candidateFor(owner.Path, { name: api.basename(owner.Path), kind: owner.IsFolder ? 'directory' : 'file' }), itemId: owner.Id };
    const versions = [ownerCandidate, ...state.links.filter(link => VIDEO_TYPES.has(owner.Type) && sameId(link.ParentId, owner.Id) && Number(link.ChildType) === 2)
      .map(link => state.byId.get(idKey(link.ChildId))).filter(Boolean).map(item =>
        ({ ...candidateFor(item.Path, { name: api.basename(item.Path), kind: 'file' }), itemId: item.Id }))];
    const resolvedFiles = new Map();
    const { extras: claims } = await collectOwnedExtras(ownerCandidate, versions, candidates,
      candidate => list(candidate.identityPath), loaded.libraryRuntimeOptions?.localization, {
        resolveExtra: async ({ candidate, classification, isInMixedFolder }) => {
          if (shouldIgnoreResolutionCandidate(candidate, { applicationRootPath: loaded.libraryRuntimeOptions?.programDataPath
            && apiFor(loaded.libraryRuntimeOptions.programDataPath).join(loaded.libraryRuntimeOptions.programDataPath, 'root') })
            || await ignoreRule.shouldIgnore(candidate.identityPath)) return false;
          const draft = { Name: classification.resolvedName, columns: { IsInMixedFolder: isInMixedFolder },
            ...(classification.resolvedYear == null ? {} : { initialColumns: { ProductionYear: classification.resolvedYear } }),
            ...(classification.nativeType === audioNativeType ? {} : { data: { VideoType: 'VideoFile', LocalAlternateVersions: [] } }) };
          const item = await this.resolveFile(candidate, { nativeType: classification.nativeType, draft, preview, loaded });
          if (item) resolvedFiles.set(candidate.identityPath, item);
          return Boolean(item);
        }
      });
    const extras = [],contexts=[];try {
    for (const claim of claims) {
      const resolved = resolvedFiles.get(claim.primary.identityPath);
      if (!resolved) continue;
      const id = nativeGuid(loaded.getNewItemId(claim.primary.identityPath, claim.nativeType));
      if (sameId(id, owner.Id)) throw conflict('An extra cannot resolve to its owner identity.');
      const cached = loaded.versionItemCache.get(idKey(id)) ?? state.byId.get(idKey(id));
      const item = cached ? preview ? cloneNativeItemEntity(cached) : cached : resolved;
      if (cached && (item.NativeType !== claim.nativeType || !sameNativePath(item.Path, claim.primary.identityPath))) {
        throw conflict('The resolved extra identity belongs to a different media item.');
      }
      if (!cached) {
        const entry = await this.files.stat(claim.primary);
        if (entry.kind !== 'file') throw conflict('The resolved extra is no longer a file.');
        item.Id = id; item.Size = entry.size ?? null; item.DateModified = dateText(entry.modified ?? MIN_DATE);
        if (loaded.metadataConfiguration.UseFileCreationTimeForDateAdded) item.DateCreated = dateText(!entry.created
          || entry.created === MIN_DATE ? new Date().toISOString() : entry.created);
        item.IsLocked = /\[dontfetchmeta\]/iu.test(item.Path);
      }
      // Hydrate locks and nullable storage dates before correcting a cached
      // entity. The database snapshot remains the persisted, uncorrected row.
      const context = await loaded.loadDraftContext(item);contexts.push(context);
      if (claim.draft.Name && !item.LockedFields.includes('Name')) item.Name = claim.draft.Name;
      const type = extraTypes[claim.extraType];
      if (item.ExtraType == null || item.ExtraType === 'Unknown' || type !== 'Unknown') item.ExtraType = type;
      item.IsInMixedFolder = claim.draft.columns.IsInMixedFolder;
      const ownerId = claim.owner.itemId;
      if (!ownerId) throw conflict('The resolved extra owner version disappeared.');
      extras.push({ item, context, ownerId, created: !cached });
      // FindExtras does not register a newly resolved entity. A cancelled or
      // failed first save must still make GetItemById report it as absent.
      if (!preview && cached) loaded.versionItemCache.set(idKey(item.Id), item);
    }
    return { extras, deletionSafe: snapshots.every(snapshot => snapshot.deletionSafe) };
    }catch(error){for(const context of contexts)await context.dispose();throw error;}
  }
}
