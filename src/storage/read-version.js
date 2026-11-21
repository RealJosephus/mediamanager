export function conditionalReadVersion(vfs, path, { version, versionReliability }) {
  if (typeof version !== 'string' || !version || ['weak', 'unavailable'].includes(versionReliability)) return null;
  return versionReliability === 'strong' || vfs.capabilities(path).reliableVersion === true ? version : null;
}
