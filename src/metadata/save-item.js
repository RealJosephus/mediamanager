import { validateMetadataSaves } from './save-manager.js';

export async function saveMetadataItem(updates, loaded, result, reason, options = {}) {
  const updated = { ...loaded, item: result.Item, context: { ...loaded.context,
    images: result.Images ?? loaded.context?.images ?? [] } };
  // Reject unsupported network writers before any independent save boundary.
  await validateMetadataSaves(updated, reason, updates.registry);
  const saves = await updates.update(loaded, result, reason, options);
  // Native SaveItemAsync saves and reattaches the parent before credits and
  // each person's metadata. Later failures retain already completed writes.
  if (result.People != null) await updates.updatePeople(loaded, result.People, { signal: options.signal });
  return saves;
}
