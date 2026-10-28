import path from 'node:path';
import { ordinalIgnoreCaseKey } from './ordinal-comparer.js';
import { isWithin, normalizePath } from './paths.js';

export const portableMountContractStateKey = 'portableVfsMountContract';

const mountIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
// A scheme token followed immediately by URI data (or an empty opaque value)
// is protocol-shaped.  Requiring the first post-colon character to be
// non-whitespace avoids mistaking legacy diagnostic text such as
// "ImagePath: ..." for a URI while still rejecting custom:opaque identities.
const protocolPattern = /^[A-Za-z][A-Za-z0-9+.-]*:(?=$|\S)/u;
const opaqueStorageProtocolPattern = /^(?:alist|dav|rclone|s3|webdav):/iu;
const windowsDrivePattern = /^[A-Za-z]:[\\/]/u;
const windowsUncPattern = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u;
const returnPolicies = new Set(['required', 'optional']);
// Jellyfin's MediaProtocol contract recognizes these remote playback schemes.
// File URLs remain filesystem identities and must go through a portable mount.
const permittedNativeMediaProtocols = new Set([
  'ftp:',
  'http:',
  'https:',
  'rtmp:',
  'rtp:',
  'rtsp:',
  'udp:',
]);
const permittedHttpProtocols = new Set(['http:', 'https:']);
const nativeProtocolPolicies = new Map([
  ['http', permittedHttpProtocols],
  ['media', permittedNativeMediaProtocols],
  ['none', new Set()],
]);

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function hasRelativeSegment(value) {
  return value.split(/[\\/]/u).some(segment => segment === '.' || segment === '..');
}

function canonicalIdentityRoot(value, style) {
  if (typeof value !== 'string' || !value || value.includes('\0') || protocolPattern.test(value) && !windowsDrivePattern.test(value)) {
    throw new TypeError('A portable mount identityRoot must be an absolute filesystem path, not a URL');
  }
  if (hasRelativeSegment(value)) throw new TypeError('A portable mount identityRoot cannot contain relative segments');
  if (style === 'windows') {
    if (!windowsDrivePattern.test(value) && !windowsUncPattern.test(value)) {
      throw new TypeError('A Windows portable mount identityRoot requires a drive or UNC share');
    }
    const normalized = path.win32.normalize(value.replaceAll('/', '\\'));
    if (windowsUncPattern.test(normalized)) {
      const [, server, share] = /^(?:\\\\)([^\\]+)\\([^\\]+)(?:\\|$)/u.exec(normalized) ?? [];
      if (!server || !share) throw new TypeError('A Windows portable mount identityRoot requires a complete UNC share');
      if (server.includes('@')) throw new TypeError('A Windows portable mount UNC server cannot contain user information');
      safeTargetSegments([server, share], 'windows');
    }
    const parsed = path.win32.parse(normalized);
    const segments = normalized.slice(parsed.root.length).split('\\').filter(Boolean);
    safeTargetSegments(segments, 'windows');
    return normalized.length > parsed.root.length ? normalized.replace(/[\\]+$/u, '') : parsed.root;
  }
  if (!value.startsWith('/') || value.includes('\\')) {
    throw new TypeError('A POSIX portable mount identityRoot must be absolute and use forward slashes');
  }
  const normalized = path.posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/u, '') : '/';
}

function canonicalMount(value, label = 'portable mount') {
  exactKeys(value, ['mountId', 'identityRoot', 'accessRoot', 'pathStyle', 'caseSensitive', 'returnPolicy'], label);
  if (typeof value.mountId !== 'string' || !mountIdPattern.test(value.mountId)) {
    throw new TypeError(`${label} mountId must be a stable lowercase identifier`);
  }
  if (!['windows', 'posix'].includes(value.pathStyle)) throw new TypeError(`${label} pathStyle must be windows or posix`);
  if (typeof value.caseSensitive !== 'boolean') throw new TypeError(`${label} caseSensitive must be a boolean`);
  if (!returnPolicies.has(value.returnPolicy)) throw new TypeError(`${label} returnPolicy must be required or optional`);
  const accessRoot = normalizePath(value.accessRoot);
  // A root access namespace makes every POSIX Jellyfin-internal path look like
  // a leaked VFS path. Portable/exportable mappings therefore use a named VFS
  // namespace, while runtime-only mappings may still mount at '/'.
  if (accessRoot === '/') throw new TypeError(`${label} accessRoot must use a named VFS namespace`);
  return Object.freeze({
    mountId: value.mountId,
    identityRoot: canonicalIdentityRoot(value.identityRoot, value.pathStyle),
    accessRoot,
    pathStyle: value.pathStyle,
    caseSensitive: value.caseSensitive,
    returnPolicy: value.returnPolicy,
  });
}

function identityKey(value, mount) {
  const normalized = mount.pathStyle === 'windows'
    ? path.win32.normalize(value.replaceAll('/', '\\'))
    : path.posix.normalize(value);
  return mount.caseSensitive ? normalized : ordinalIgnoreCaseKey(normalized);
}

function identityWithin(value, mount) {
  const windows = mount.pathStyle === 'windows';
  if (windows ? !windowsDrivePattern.test(value) && !windowsUncPattern.test(value) : !value.startsWith('/') || value.includes('\\')) return false;
  if (hasRelativeSegment(value)) throw new Error('A Jellyfin media path contains relative segments');
  const normalized = windows ? path.win32.normalize(value.replaceAll('/', '\\')) : path.posix.normalize(value);
  const root = identityKey(mount.identityRoot, mount);
  const candidate = identityKey(normalized, mount);
  const separator = windows ? '\\' : '/';
  return candidate === root || candidate.startsWith(root.endsWith(separator) ? root : root + separator);
}

function validateContractRelationships(mounts) {
  const ids = new Set();
  for (const mount of mounts) {
    if (ids.has(mount.mountId)) throw new TypeError(`Duplicate portable mountId ${mount.mountId}`);
    ids.add(mount.mountId);
  }
  for (let leftIndex = 0; leftIndex < mounts.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < mounts.length; rightIndex++) {
      const left = mounts[leftIndex], right = mounts[rightIndex];
      if (isWithin(left.accessRoot, right.accessRoot) || isWithin(right.accessRoot, left.accessRoot)) {
        throw new TypeError(`Portable mount access roots overlap: ${left.mountId}, ${right.mountId}`);
      }
      const sameIdentityRoot = left.caseSensitive && right.caseSensitive
        ? left.identityRoot === right.identityRoot
        : ordinalIgnoreCaseKey(left.identityRoot) === ordinalIgnoreCaseKey(right.identityRoot);
      if (left.pathStyle === right.pathStyle && sameIdentityRoot) {
        throw new TypeError(`Portable mount identity roots are ambiguous: ${left.mountId}, ${right.mountId}`);
      }
    }
  }
}

/**
 * Canonical portable state deliberately contains no adapter type, backend URL,
 * credential reference, secret, or protocol-specific root.
 */
export function canonicalPortableMountContract(value) {
  exactKeys(value, ['mounts'], 'portable VFS mount contract');
  if (!Array.isArray(value.mounts)) throw new TypeError('Portable VFS mount contract mounts must be an array');
  const mounts = value.mounts.map((mount, index) => canonicalMount(mount, `portable mount ${index}`))
    .sort((left, right) => left.mountId.localeCompare(right.mountId, 'en'));
  validateContractRelationships(mounts);
  return Object.freeze({ mounts: Object.freeze(mounts) });
}

export function serializePortableMountContract(value) {
  return JSON.stringify(canonicalPortableMountContract(value));
}

export function parsePortableMountContract(value) {
  if (typeof value !== 'string') throw new TypeError('Stored portable VFS mount contract must be JSON text');
  let parsed;
  try { parsed = JSON.parse(value); }
  catch (error) { throw new TypeError('Stored portable VFS mount contract is not valid JSON', { cause: error }); }
  return canonicalPortableMountContract(parsed);
}

export async function readPortableMountContract(database) {
  if (database?.dialect !== 'postgres' || typeof database.getState !== 'function') {
    throw new TypeError('Portable VFS mount contracts are persisted in PostgreSQL control state');
  }
  const value = await database.getState(portableMountContractStateKey);
  return value === undefined ? null : parsePortableMountContract(value);
}

export async function writePortableMountContract(database, value) {
  const serialized = serializePortableMountContract(value);
  const current = await readPortableMountContract(database);
  if (current && serializePortableMountContract(current) !== serialized) {
    throw new Error('Stored portable VFS mount contract differs');
  }
  if (!current) await database.setState(portableMountContractStateKey, serialized);
  const actual = await database.getState(portableMountContractStateKey);
  if (actual !== serialized) throw new Error('Stored portable VFS mount contract differs');
  return parsePortableMountContract(actual);
}

export function assertPortableMountRetarget(sourceValue, targetValue) {
  const source = canonicalPortableMountContract(sourceValue);
  const target = canonicalPortableMountContract(targetValue);
  if (source.mounts.length !== target.mounts.length) throw new TypeError('Target portable mount contract must preserve every mountId');
  const targetById = new Map(target.mounts.map(mount => [mount.mountId, mount]));
  for (const mount of source.mounts) {
    const replacement = targetById.get(mount.mountId);
    if (!replacement || replacement.accessRoot !== mount.accessRoot || replacement.returnPolicy !== mount.returnPolicy) {
      throw new TypeError(`Target portable mount ${mount.mountId} must preserve mountId, accessRoot and returnPolicy`);
    }
  }
  return target;
}

function configuredContract(prefixes) {
  return canonicalPortableMountContract({
    mounts: prefixes.filter(prefix => prefix.style !== 'uri' && !['application','metadata'].includes(prefix.purpose)).map((prefix, index) => ({
      mountId: `configured-${index}`,
      identityRoot: prefix.identityRoot,
      accessRoot: prefix.accessRoot,
      pathStyle: prefix.style ?? 'posix',
      caseSensitive: prefix.caseSensitive ?? true,
      returnPolicy: 'required',
    })),
  });
}

function sameRuntimeMapping(left, right) {
  if (left.accessRoot !== right.accessRoot || left.pathStyle !== right.pathStyle
    || left.caseSensitive !== right.caseSensitive) return false;
  return left.caseSensitive
    ? left.identityRoot === right.identityRoot
    : ordinalIgnoreCaseKey(left.identityRoot) === ordinalIgnoreCaseKey(right.identityRoot);
}

/** Verify that runtime-only adapter configuration resolves exactly the path
 * namespaces persisted in PostgreSQL. Adapter URLs and credentials deliberately
 * remain outside the portable contract. */
export function assertPortableMountStorageConfiguration(contractValue, { prefixes, mounts, bindings = [] }) {
  const contract = canonicalPortableMountContract(contractValue);
  if (!Array.isArray(prefixes) || !Array.isArray(mounts) || !Array.isArray(bindings)) {
    throw new TypeError('Storage path configuration requires prefixes, mounts and bindings arrays');
  }
  const configured = configuredContract(prefixes);
  const remaining = [...contract.mounts];
  for (const prefix of configured.mounts) {
    const match = remaining.findIndex(mount => sameRuntimeMapping(prefix, mount));
    if (match < 0) throw new Error('Storage identity prefixes differ from the persisted portable VFS mount contract');
    remaining.splice(match, 1);
  }
  if (remaining.length) {
    throw new Error('Storage identity prefixes differ from the persisted portable VFS mount contract');
  }

  const runtimeMounts = mounts.map((mount, index) => {
    try { return normalizePath(mount?.path); }
    catch (cause) { throw new TypeError(`Storage mount ${index} has an invalid VFS path`, { cause }); }
  });
  for (const mount of contract.mounts) if (!runtimeMounts.some(root => isWithin(mount.accessRoot, root))) {
    throw new Error(`Portable mount ${mount.mountId} is not backed by a configured VFS mount`);
  }
  for (const [index, binding] of bindings.entries()) {
    let accessPath;
    try { accessPath = normalizePath(binding?.accessPath); }
    catch (cause) { throw new TypeError(`Storage binding ${index} has an invalid VFS path`, { cause }); }
    if (!contract.mounts.some(mount => isWithin(accessPath, mount.accessRoot))) {
      throw new Error(`Storage binding ${index} is outside the persisted portable VFS mount contract`);
    }
  }
  return contract;
}

function safeTargetSegments(segments, style) {
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.includes('\0')) {
      throw new Error('A portable path rewrite contains an invalid path segment');
    }
    if (style === 'windows' && (/[\u0000-\u001F<>:"/\\|?*]/u.test(segment)
      || /[ .]$/u.test(segment) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(segment))) {
      throw new Error(`A portable path segment cannot be represented on Windows: ${segment}`);
    }
  }
}

function relativeSegments(value, mount) {
  const api = mount.pathStyle === 'windows' ? path.win32 : path.posix;
  const normalized = mount.pathStyle === 'windows' ? path.win32.normalize(value.replaceAll('/', '\\')) : path.posix.normalize(value);
  const relative = api.relative(mount.identityRoot, normalized);
  if (relative === '') return [];
  const segments = relative.split(mount.pathStyle === 'windows' ? /[\\/]/u : '/');
  if (api.isAbsolute(relative) || segments.some(segment => segment === '..')) throw new Error('A Jellyfin media path escaped its portable mount');
  return segments;
}

function joinIdentity(root, segments, style) {
  safeTargetSegments(segments, style);
  const api = style === 'windows' ? path.win32 : path.posix;
  return segments.length ? api.join(root, ...segments) : root;
}

function protocolPath(value) {
  return (protocolPattern.test(value) || opaqueStorageProtocolPattern.test(value))
    && !windowsDrivePattern.test(value);
}

function permittedNativeUrl(value, protocolPolicy) {
  let parsed;
  try { parsed = new URL(value); }
  catch { return false; }
  return nativeProtocolPolicies.get(protocolPolicy).has(parsed.protocol) && Boolean(parsed.hostname)
    && parsed.username === '' && parsed.password === '';
}

function permittedJellyfinInternalPath(value) {
  const match = /^(?:%AppDataPath%|%MetadataPath%)(?:[\\/](.*))?$/iu.exec(value);
  if (!match) return false;
  const segments = match[1] === undefined ? [] : match[1].split(/[\\/]/u);
  try { safeTargetSegments(segments, 'windows'); }
  catch { return false; }
  return true;
}

function internalAccessMount(value, ...contracts) {
  if (!value.startsWith('/') || value.includes('\\')) return null;
  let accessPath;
  try { accessPath = normalizePath(value); }
  catch { return null; }
  for (const contract of contracts) {
    const leaked = contract?.mounts.find(mount => isWithin(accessPath, mount.accessRoot));
    if (leaked) return leaked;
  }
  return null;
}

/** Project one filesystem-semantic value from a persisted mount contract to an
 * explicitly retargeted contract. Exported absolute paths can be required to
 * belong to the contract; protocol URLs and internal VFS access paths always
 * fail closed except for a field that explicitly permits a Jellyfin-native
 * remote playback protocol. */
export function projectPortableJellyfinPath(value, sourceValue, targetValue = sourceValue,
  { label = 'Jellyfin path', protocolPolicy = 'none', allowInternalPath = false, requireMount = false } = {}) {
  if (value == null || value === '') return value;
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  if (!nativeProtocolPolicies.has(protocolPolicy)) throw new TypeError(`${label} has an invalid native protocol policy`);
  if (value.includes('\0')) throw new Error(`${label} contains NUL`);
  if (allowInternalPath && permittedJellyfinInternalPath(value)) return value;
  if (protocolPath(value)) {
    // Remote stream targets are native Jellyfin data. Adapter-specific and
    // unknown schemes are not accepted as portable storage identities.
    if (!opaqueStorageProtocolPattern.test(value) && permittedNativeUrl(value, protocolPolicy)) return value;
    throw new Error(`${label} contains a storage protocol URL`);
  }
  const source = sourceValue == null ? null : canonicalPortableMountContract(sourceValue);
  const target = source == null ? null : assertPortableMountRetarget(source, targetValue ?? source);
  if (!source) return value;
  const retargeted = JSON.stringify(source) !== JSON.stringify(target);
  // Access namespaces are never portable identity paths. Check them before
  // identity roots so even an overly broad POSIX identity root cannot disguise
  // an internal VFS path as native Jellyfin state.
  const leaked = internalAccessMount(value, source, target);
  if (leaked) throw new Error(`${label} contains VFS access path for mount ${leaked.mountId}`);
  const matches = source.mounts.filter(mount => identityWithin(value, mount))
    .sort((left, right) => right.identityRoot.length - left.identityRoot.length);
  if (matches.length) {
    const mount = matches[0], replacement = target.mounts.find(candidate => candidate.mountId === mount.mountId);
    const projected = joinIdentity(replacement.identityRoot, relativeSegments(value, mount), replacement.pathStyle);
    if (protocolPath(projected)) throw new Error(`${label} retarget produced a storage protocol URL`);
    const projectedLeak = internalAccessMount(projected, source, target);
    if (projectedLeak) throw new Error(`${label} retarget produced VFS access path for mount ${projectedLeak.mountId}`);
    if (!identityWithin(projected, replacement)) throw new Error(`${label} retarget escaped its portable mount`);
    const projectedOwner = target.mounts.filter(candidate => identityWithin(projected, candidate))
      .sort((left, right) => right.identityRoot.length - left.identityRoot.length)[0];
    if (projectedOwner?.mountId !== replacement.mountId) {
      throw new Error(`${label} retarget changed portable mount identity from ${mount.mountId} to ${projectedOwner?.mountId}`);
    }
    // A source-only export is an audit, not a normalization pass. Jellyfin may
    // have persisted different-but-equivalent drive casing or Windows
    // separators, and the no-retarget contract requires those bytes to remain
    // unchanged in the returned SQLite database.
    return retargeted ? projected : value;
  }
  if (requireMount) throw new Error(`${label} is outside every portable mount`);
  return value;
}
