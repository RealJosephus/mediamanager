import { idKey, VIDEO_TYPES } from '../library/records.js';

export const videoRepositoryFields = Object.freeze([
  'Overview', 'ProductionYear', 'PremiereDate', 'CommunityRating', 'OfficialRating', 'Genres', 'ProviderIds'
]);
const conflict = message => Object.assign(new Error(message), { code: 'metadata-conflict', status: 409 });

export function copyLocalAlternateMetadata(owner, child, images = owner.context.images) {
  // Unlike RefreshMetadataForOwnedItem, the repository override clears nullable
  // dates and shares the owner's arrays, dictionary and image objects.
  for (const field of videoRepositoryFields) child.item[field] = owner.item[field];
  child.context = { ...child.context, images };
  return { Item: child.item, Images: images };
}

export function assertVideoRepositoryPath(item, ancestors = []) {
  const key = idKey(item.Id);
  if (ancestors.includes(key)) throw conflict('A local-version repository update cannot revisit an active ancestor.');
  return [...ancestors, key];
}

export async function localAlternateVersionIds(loaded, { preflight = false } = {}) {
  if (!VIDEO_TYPES.has(loaded.item.Type)) return [];
  if (typeof loaded.getLocalAlternateVersionIds !== 'function') {
    throw Object.assign(new Error('Video repository updates require authoritative local-version identities.'), { status: 501 });
  }
  return loaded.getLocalAlternateVersionIds(preflight ? loaded.item : undefined);
}

export async function loadLocalAlternateContext(loaded, reference) {
  if (typeof loaded.reloadMetadataContext !== 'function') {
    throw Object.assign(new Error('Local-version repository updates require an authoritative context loader.'), { status: 501 });
  }
  try { return await loaded.reloadMetadataContext(reference); }
  catch (error) {
    // Native Video filters missing GetItemById results, not lookup failures.
    if (error.status === 404 || error.statusCode === 404) return null;
    throw error;
  }
}
