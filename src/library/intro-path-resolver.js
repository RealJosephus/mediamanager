import { nativeFileName } from './native-path.js';
import { filterResolutionCandidates } from './resolution-ignore.js';
import { nativeItemDescriptor } from './native-item-entity.js';

/** Resolve an intro identity through the normal storage and single-item resolvers. */
export function createIntroPathResolver({ vfs, identityMap, ignoreRule, resolverPipeline, applicationRootPath }) {
  const candidate = async identityPath => {
    const style = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(identityPath) ? 'windows' : 'posix';
    const accessPath = identityMap.resolve({ identityPath, style });
    let entry;
    try { entry = await vfs.stat(accessPath); }
    catch (error) {
      if (!['not-found', 'ENOENT'].includes(error.code)) throw error;
      entry = { kind: 'file', size: 0n };
    }
    return { identityPath, accessPath, entry: { ...entry, name: nativeFileName(identityPath) } };
  };
  const classify = (accessRoot, entries) => entries.map(entry => {
    const accessPath = accessRoot.replace(/\/$/u, '') + '/' + entry.name;
    return { identityPath: identityMap.identityFor(accessPath).identityPath, accessPath, entry };
  });
  return async identityPath => {
    const current = await candidate(identityPath);
    const options = { ignoreRule, applicationRootPath };
    if (!(await filterResolutionCandidates([current], options)).length) return null;
    const claim = await resolverPipeline.resolvePath({ candidate: current,
      peekDirectory: async directory => {
        const listing = await vfs.list(directory.accessPath);
        const candidates = await filterResolutionCandidates(classify(directory.accessPath, listing.entries), options);
        return { listing, candidates };
      } });
    return claim ? { Id: claim.Id, Type: nativeItemDescriptor(claim.nativeType).type,
      Name: claim.draft.Name, Path: claim.identityPath } : null;
  };
}
