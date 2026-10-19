import { setResolverInitialValues } from './resolver-initial-values.js';
import { applyNativeItemValues, newNativeItemEntity, nativeItemDescriptor,
  initializeNativeResolvedRelationships } from './native-item-entity.js';

/** Turn a provenance-validated resolver claim into its native live entity.
 * Ownership, links and repository defaults are applied by their own lifecycle. */
export function createResolvedItemEntity(claim, options = {}) {
  const descriptor = nativeItemDescriptor(claim.nativeType);
  if (!descriptor.resolverCreation) throw new TypeError(`Unimplemented resolved entity constructor: ${claim.nativeType}`);
  const item = newNativeItemEntity(claim.nativeType);
  if (options.parent) applyNativeItemValues(item, { ParentId: options.parent.Id });
  applyNativeItemValues(item, claim.draft.columns, claim.draft.initialColumns, claim.draft.data,
    { Id: claim.Id, Name: claim.draft.Name, Path: claim.identityPath },
    Object.fromEntries(['IsFolder', 'MediaType', 'SourceType'].filter(key => claim.draft[key] !== undefined)
      .map(key => [key, claim.draft[key]])));
  setResolverInitialValues(item, { ...options, identityPath: claim.identityPath, entry: claim.entry });
  if (item.IsFolder !== claim.draft.IsFolder) throw new TypeError('The resolved entity has an inconsistent native folder shape.');
  return initializeNativeResolvedRelationships(item, options);
}
