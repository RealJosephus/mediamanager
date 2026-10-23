import { setTimeout as delay } from 'node:timers/promises';
import { assertVideoRepositoryPath, copyLocalAlternateMetadata, localAlternateVersionIds, loadLocalAlternateContext } from './video-repository.js';
import { cloneNativeItemEntity, releaseNativeItemLinks } from '../library/native-item-entity.js';

export const ItemUpdateType = Object.freeze({ None: 1, MetadataImport: 2, ImageUpdate: 4, MetadataDownload: 8, MetadataEdit: 16 });

export async function isSaverEnabled(saver, item, updateType, { libraryOptions = {}, globalOptions = {}, includeDisabled = false, exists, saveLocalMetadataEnabled = item.SaveLocalMetadata === true, context = {}, logger = { error() {} } } = {}) {
  try {
    if (!await saver.isEnabledFor(item, updateType, context)) return false;
    if (includeDisabled) return true;
    if (libraryOptions.MetadataSavers == null) {
      if ((globalOptions.DisabledMetadataSavers ?? []).some((name) => name.toLowerCase() === saver.name.toLowerCase())) return false;
      if (!saveLocalMetadataEnabled && (updateType < ItemUpdateType.MetadataEdit || !saver.getSavePath || !await exists(saver.getSavePath(item, context)))) return false;
    } else if (!libraryOptions.MetadataSavers.some((name) => name.toLowerCase() === saver.name.toLowerCase())) return false;
    return true;
  } catch (error) { logger.error(error, 'Error determining metadata saver availability'); return false; }
}

export async function validateMetadataSaves(loaded, updateType, registry, ancestors = []) {
  const path = assertVideoRepositoryPath(loaded.item, ancestors);
  for (const saver of loaded.item.IsFileProtocol ? registry?.discover({ ...loaded, kind: 'saver' }) ?? [] : []) {
    if (!await isSaverEnabled(saver, loaded.item, updateType, loaded)) continue;
    if (typeof saver.validateSave !== 'function') throw Object.assign(new Error(`Metadata saver '${saver.name}' cannot validate its network destination.`), { status: 501 });
    await saver.validateSave(loaded.item, loaded.context);
  }
  // D3 applies to the entire recursive repository family before parent files,
  // images, probe, credits or its first independent DB commit can change state.
  for (const reference of await localAlternateVersionIds(loaded, { preflight: true })) {
    const child = await loadLocalAlternateContext(loaded, reference);
    if (!child) continue;
    let draft;
    try {
      draft = { ...child, item: cloneNativeItemEntity(child.item), context: { ...child.context } };
      copyLocalAlternateMetadata(loaded, draft);
      await validateMetadataSaves(draft, ItemUpdateType.MetadataDownload, registry, path);
    } finally {
      if (draft) releaseNativeItemLinks(draft.item);
      await child.dispose?.();
    }
  }
  const previews = await loaded.previewLocalAlternateContexts?.(loaded.item) ?? [];
  try {
    for (const child of previews) {
      let draft;
      try {
        draft = { ...child, item: cloneNativeItemEntity(child.item), context: { ...child.context } };
        copyLocalAlternateMetadata(loaded, draft);
        await validateMetadataSaves(draft, ItemUpdateType.MetadataDownload, registry, path);
      } finally {
        if (draft) releaseNativeItemLinks(draft.item);
      }
    }
  } finally { await Promise.all(previews.map(child => child.dispose?.())); }
}

export async function saveMetadata(item, updateType, savers, { now = () => new Date().toISOString(), monitor = {}, logger = { error() {} }, context = {}, ...selection } = {}) {
  const applicable = [];
  for (const saver of savers) if (await isSaverEnabled(saver, item, updateType, { ...selection, logger, context })) applicable.push(saver);
  const outcomes = [];
  for (const saver of applicable) {
    let path;
    try { path = saver.getMonitorPath ? saver.getMonitorPath(item, context) : saver.getSavePath?.(item, context); }
    catch (error) { logger.error(error, 'Error resolving metadata save path'); outcomes.push({ saver: saver.id, error }); continue; }
    try {
      if (path != null) monitor.reportFileSystemChangeBeginning?.(path);
      // The baseline intentionally uses CancellationToken.None in this manager entry point.
      const result = await saver.save(item, { ...context, signal: undefined });
      // File timestamps retain submillisecond precision. Reading a truncated
      // wall clock in the write's own tick would mark this very save changed.
      // Wait for a real clock transition; preserve file times and comparisons.
      const completedTick = Date.now();
      do { await delay(1); } while (Date.now() === completedTick);
      item.DateLastSaved = now(); outcomes.push({ saver: saver.id, result });
    } catch (error) { logger.error(error, 'Error in metadata saver'); outcomes.push({ saver: saver.id, error }); }
    finally { if (path != null) monitor.reportFileSystemChangeComplete?.(path, false); }
  }
  return outcomes;
}
