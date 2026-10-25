import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectInstanceConfiguration } from '../configuration.js';
import { decodeServerIdentity, isServerIdentity } from '../core/server-identity.js';

const instanceStateKind = 'jellyfin-instance-state';
const sha256Pattern = /^[a-f0-9]{64}$/u;

const sha256 = value => createHash('sha256').update(value).digest('hex');
const timestampFromNanoseconds = value => new Date(Number(value / 1_000_000n)).toISOString();
const fileSha256 = async filename => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
};
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort(compareText).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}
const pathKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const pathsOverlap = (left, right) => {
  const relative = path.relative(left, right);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function exactKeys(value, keys, label) {
  plainRecord(value, label);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${label}`);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid ${label}`);
  }
}

function configuredPath(value, fallback, label) {
  if (value == null || (typeof value === 'string' && !value.trim())) return fallback;
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const relative = value.slice(path.parse(value).root.length);
  if (relative.split(/[\\/]+/u).some(part => part === '.' || part === '..')) throw new Error(`${label} contains a path alias`);
  return value;
}

async function directoryIdentity(value, label) {
  const resolved = path.resolve(value);
  let metadata;
  try { metadata = await lstat(resolved); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Missing required Jellyfin ${label}: ${resolved}`); throw error; }
  if (metadata.isSymbolicLink()) throw new Error(`Jellyfin ${label} must not be a symbolic link: ${resolved}`);
  if (!metadata.isDirectory()) throw new Error(`Jellyfin ${label} must be a directory: ${resolved}`);
  const physical = await realpath(resolved);
  if (pathKey(physical) !== pathKey(resolved)) throw new Error(`Jellyfin ${label} uses a path alias: ${resolved}`);
  return physical;
}

async function regularFileIdentity(value, label, { required = true } = {}) {
  const resolved = path.resolve(value);
  let metadata;
  try { metadata = await lstat(resolved); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return undefined;
    if (error.code === 'ENOENT') throw new Error(`Missing required Jellyfin ${label}: ${resolved}`);
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`Jellyfin ${label} must not be a symbolic link: ${resolved}`);
  if (!metadata.isFile()) throw new Error(`Jellyfin ${label} must be a regular file: ${resolved}`);
  const physical = await realpath(resolved);
  if (pathKey(physical) !== pathKey(resolved)) throw new Error(`Jellyfin ${label} uses a path alias: ${resolved}`);
  return physical;
}

async function databaseGeneration(sqlitePath) {
  const databaseDirectory = path.dirname(sqlitePath), databaseName = path.basename(sqlitePath);
  const unsafeCompanions = (await readdir(databaseDirectory)).filter(name => {
    const candidate = process.platform === 'win32' ? name.toLowerCase() : name;
    const base = process.platform === 'win32' ? databaseName.toLowerCase() : databaseName;
    return candidate === `${base}-journal` || candidate === `${base}-stmtjrnl` || candidate.startsWith(`${base}-mj`);
  });
  if (unsafeCompanions.length) {
    throw new Error(`Stopped Jellyfin SQLite has an unsafe rollback or super-journal companion: ${unsafeCompanions.sort(compareText).join(', ')}`);
  }
  const files = [];
  for (const [role, suffix, required] of [['sqlite', '', true], ['wal', '-wal', false], ['shm', '-shm', false]]) {
    const filename = await regularFileIdentity(`${sqlitePath}${suffix}`, `SQLite ${role} file`, { required });
    if (!filename) continue;
    const before = await lstat(filename, { bigint: true }), digest = await fileSha256(filename), after = await lstat(filename, { bigint: true });
    const generation = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
    if (generation(before) !== generation(after)) throw new Error(`Jellyfin SQLite ${role} file changed while its generation was hashed`);
    files.push({ role, bytes: before.size.toString(), modifiedAt: timestampFromNanoseconds(before.mtimeNs), sha256: digest });
  }
  return { algorithm: 'sha256', digest: sha256(canonicalJson(files)), files };
}

function generationPathParts(value) {
  if (typeof value !== 'string' || value.includes('\\') || value.startsWith('/')
    || value.split('/').some(part => part === '.' || part === '..' || !part)) throw new Error('Invalid Jellyfin state generation path');
  return value ? value.split('/') : [];
}

/** Calculate the canonical digest for a complete set of state records. */
export function calculateStateGeneration(rootLabels, records) {
  if (!Array.isArray(rootLabels) || rootLabels.length === 0 || new Set(rootLabels).size !== rootLabels.length
    || rootLabels.some(label => typeof label !== 'string' || !label)) throw new Error('Invalid Jellyfin state generation roots');
  if (!Array.isArray(records)) throw new Error('Invalid Jellyfin state generation records');
  const roots = [...rootLabels].sort(compareText);
  const rootSet = new Set(roots), seen = new Set(), directories = new Set(), normalized = [];
  for (const value of records) {
    plainRecord(value, 'Jellyfin state generation record');
    if (!rootSet.has(value.label) || !['directory', 'file'].includes(value.kind)) throw new Error('Invalid Jellyfin state generation record');
    const parts = value.path === '' ? [] : generationPathParts(value.path);
    canonicalTimestamp(value.modifiedAt, 'Jellyfin state generation modifiedAt');
    const key = `${value.label}\0${value.path}`;
    if (seen.has(key)) throw new Error('Duplicate Jellyfin state generation record');
    seen.add(key);
    if (value.kind === 'directory') {
      exactKeys(value, ['label', 'path', 'kind', 'modifiedAt'], 'Jellyfin state generation directory');
      directories.add(key);
      normalized.push({ label: value.label, path: value.path, kind: 'directory', modifiedAt: value.modifiedAt, parts });
    } else {
      exactKeys(value, ['label', 'path', 'kind', 'bytes', 'modifiedAt', 'sha256'], 'Jellyfin state generation file');
      if (!/^(?:0|[1-9]\d*)$/u.test(value.bytes) || !sha256Pattern.test(value.sha256)) throw new Error('Invalid Jellyfin state generation file');
      normalized.push({ label: value.label, path: value.path, kind: 'file', bytes: value.bytes,
        modifiedAt: value.modifiedAt, sha256: value.sha256, parts });
    }
  }
  for (const label of roots) if (!directories.has(`${label}\0`)) throw new Error(`Missing Jellyfin state generation root: ${label}`);
  for (const record of normalized) {
    if (record.path === '') {
      if (record.kind !== 'directory') throw new Error('Jellyfin state generation root must be a directory');
      continue;
    }
    const parent = record.parts.slice(0, -1).join('/');
    if (!directories.has(`${record.label}\0${parent}`)) throw new Error(`Missing Jellyfin state generation parent directory: ${record.path}`);
  }
  normalized.sort((left, right) => {
    const rootOrder = roots.indexOf(left.label) - roots.indexOf(right.label);
    if (rootOrder) return rootOrder;
    const count = Math.min(left.parts.length, right.parts.length);
    for (let index = 0; index < count; index++) {
      if (left.parts[index] < right.parts[index]) return -1;
      if (left.parts[index] > right.parts[index]) return 1;
    }
    return left.parts.length - right.parts.length;
  });
  const hash = createHash('sha256');
  hash.update(`${JSON.stringify({ roots })}\n`);
  let directoryCount = 0, fileCount = 0, bytes = 0n;
  for (const record of normalized) {
    const { parts: _parts, ...serialized } = record;
    hash.update(`${JSON.stringify(serialized)}\n`);
    if (record.kind === 'directory') directoryCount++;
    else { fileCount++; bytes += BigInt(record.bytes); }
  }
  return { algorithm: 'sha256', digest: hash.digest('hex'), rootCount: roots.length,
    directoryCount, fileCount, bytes: bytes.toString() };
}

async function stateGeneration(roots) {
  const records = [];
  const generation = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
  const visit = async (label, root, relative = '') => {
    const directory = path.join(root, relative), before = await lstat(directory, { bigint: true });
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`Jellyfin state directory changed during generation capture: ${directory}`);
    records.push({ label, path: relative.split(path.sep).join('/'), kind: 'directory',
      modifiedAt: timestampFromNanoseconds(before.mtimeNs) });
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const childRelative = path.join(relative, entry.name), filename = path.join(root, childRelative);
      const metadata = await lstat(filename, { bigint: true });
      if (metadata.isSymbolicLink()) throw new Error(`Jellyfin state contains a symbolic link: ${filename}`);
      if (metadata.isDirectory()) await visit(label, root, childRelative);
      else if (metadata.isFile()) {
        const digest = await fileSha256(filename), after = await lstat(filename, { bigint: true });
        if (generation(metadata) !== generation(after)) throw new Error(`Jellyfin state file changed during generation capture: ${filename}`);
        records.push({ label, path: childRelative.split(path.sep).join('/'), kind: 'file', bytes: metadata.size.toString(),
          modifiedAt: timestampFromNanoseconds(metadata.mtimeNs), sha256: digest });
      } else throw new Error(`Jellyfin state contains an unsupported filesystem entry: ${filename}`);
    }
    const after = await lstat(directory, { bigint: true });
    if (generation(before) !== generation(after)) throw new Error(`Jellyfin state directory changed during generation capture: ${directory}`);
  };
  const ordered = Object.entries(roots).sort(([left], [right]) => compareText(left, right));
  for (const [label, root] of ordered) await visit(label, root);
  return calculateStateGeneration(ordered.map(([label]) => label), records);
}

async function assertCaptureTree(root, relative = '') {
  const directory = path.join(root, relative);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = path.join(relative, entry.name), filename = path.join(root, childRelative);
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) throw new Error(`Jellyfin state contains a symbolic link: ${filename}`);
    if (metadata.isDirectory()) await assertCaptureTree(root, childRelative);
    else if (!metadata.isFile()) throw new Error(`Jellyfin state contains an unsupported filesystem entry: ${filename}`);
  }
}

async function assertRestoredStateMarker(filename, instanceRoot) {
  await regularFileIdentity(filename, 'MediaManager restored-state marker');
  let marker;
  try { marker = JSON.parse(await readFile(filename, 'utf8')); }
  catch { throw new Error('Invalid MediaManager restored-state marker'); }
  exactKeys(marker, ['generation', 'manifestSha256', 'layoutSha256', 'systemConfigurationSha256',
    'destination', 'stage', 'database', 'extensionStateSha256', 'mediaAccessSha256'], 'MediaManager restored-state marker');
  exactKeys(marker.database, ['restorePath', 'sha256'], 'MediaManager restored-state database marker');
  if (marker.stage !== 'complete' || pathKey(marker.destination) !== pathKey(instanceRoot)
    || typeof marker.generation !== 'string' || !/^[a-f0-9-]{36}$/iu.test(marker.generation)
    || !sha256Pattern.test(marker.manifestSha256) || !sha256Pattern.test(marker.layoutSha256)
    || !sha256Pattern.test(marker.systemConfigurationSha256) || !sha256Pattern.test(marker.extensionStateSha256)
    || !sha256Pattern.test(marker.mediaAccessSha256) || marker.database.restorePath !== 'data/data/jellyfin.db'
    || !sha256Pattern.test(marker.database.sha256)) throw new Error('Invalid MediaManager restored-state marker');
}

async function controlGeneration(instanceRoot, roots) {
  const filesystemGeneration = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
  const rootBefore = await lstat(instanceRoot, { bigint: true });
  if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
    throw new Error(`Jellyfin instance root changed during control generation capture: ${instanceRoot}`);
  }
  const modeled = new Map(Object.entries(roots)
    .filter(([, value]) => pathKey(path.dirname(value)) === pathKey(instanceRoot))
    .map(([label, value]) => [pathKey(value), label]));
  const seenRoots = new Set(), inventory = [];
  let restoredState = null;
  const entries = (await readdir(instanceRoot, { withFileTypes: true }))
    .sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const filename = path.join(instanceRoot, entry.name), rootLabel = modeled.get(pathKey(filename));
    if (rootLabel) {
      const metadata = await lstat(filename);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || pathKey(await realpath(filename)) !== pathKey(filename)) {
        throw new Error(`Jellyfin state root changed during control generation capture: ${filename}`);
      }
      seenRoots.add(rootLabel);
      inventory.push({ name: entry.name, kind: 'state-root', root: rootLabel });
      continue;
    }
    if (entry.name === 'mediamanager-state.json') {
      const before = await lstat(filename, { bigint: true });
      await assertRestoredStateMarker(filename, instanceRoot);
      const digest = await fileSha256(filename), after = await lstat(filename, { bigint: true });
      if (filesystemGeneration(before) !== filesystemGeneration(after)) {
        throw new Error('MediaManager restored-state marker changed during generation capture');
      }
      restoredState = { bytes: before.size.toString(), modifiedAt: timestampFromNanoseconds(before.mtimeNs), sha256: digest };
      inventory.push({ name: entry.name, kind: 'restored-state' });
      continue;
    }
    throw new Error(`Unmodeled Jellyfin instance top-level entry: ${filename}`);
  }
  if (seenRoots.size !== modeled.size) throw new Error('Jellyfin instance top-level state changed during control generation capture');
  const rootAfter = await lstat(instanceRoot, { bigint: true });
  if (filesystemGeneration(rootBefore) !== filesystemGeneration(rootAfter)) {
    throw new Error('Jellyfin instance top-level state changed during control generation capture');
  }
  const payload = { inventory, restoredState };
  return { algorithm: 'sha256', digest: sha256(canonicalJson(payload)), inventory, restoredState };
}

function orderedRoots(roots) {
  return Object.entries(roots).sort(([left], [right]) => compareText(left, right)).map(([label, value]) => ({ label, path: value }));
}

function pathBinding(roots, effectivePath, configured, label) {
  const containing = Object.entries(roots).filter(([, root]) => pathsOverlap(root, effectivePath));
  if (containing.length !== 1) throw new Error(`Jellyfin ${label} path must belong to exactly one discovered state root`);
  const [rootLabel, root] = containing[0];
  return { configured, root: rootLabel, relativePath: path.relative(root, effectivePath).split(path.sep).join('/') };
}

function identityPayload(state) {
  return {
    kind: state.kind,
    instanceRoot: state.instanceRoot,
    serverId: state.identity.serverId,
    criticalFiles: {
      systemConfiguration: state.identity.criticalFiles.systemConfiguration,
      networkConfiguration: state.identity.criticalFiles.networkConfiguration,
      serverIdentity: state.identity.criticalFiles.serverIdentity,
    },
    databaseGeneration: {
      algorithm: state.identity.databaseGeneration.algorithm,
      digest: state.identity.databaseGeneration.digest,
      files: state.identity.databaseGeneration.files.map(file => ({ role: file.role, bytes: file.bytes,
        modifiedAt: file.modifiedAt, sha256: file.sha256 })),
    },
    controlGeneration: {
      algorithm: state.identity.controlGeneration.algorithm,
      digest: state.identity.controlGeneration.digest,
      restoredState: state.identity.controlGeneration.restoredState === null ? null : {
        bytes: state.identity.controlGeneration.restoredState.bytes,
        modifiedAt: state.identity.controlGeneration.restoredState.modifiedAt,
        sha256: state.identity.controlGeneration.restoredState.sha256,
      },
    },
    stateGeneration: {
      algorithm: state.identity.stateGeneration.algorithm,
      digest: state.identity.stateGeneration.digest,
      rootCount: state.identity.stateGeneration.rootCount,
      directoryCount: state.identity.stateGeneration.directoryCount,
      fileCount: state.identity.stateGeneration.fileCount,
      bytes: state.identity.stateGeneration.bytes,
    },
    paths: {
      programData: state.paths.programData,
      configuration: state.paths.configuration,
      defaultMetadata: state.paths.defaultMetadata,
      metadata: state.paths.metadata,
      defaultCache: state.paths.defaultCache,
      cache: state.paths.cache,
      log: state.paths.log,
      sqlite: state.paths.sqlite,
    },
    pathBindings: {
      metadata: { configured: state.pathBindings.metadata.configured, root: state.pathBindings.metadata.root,
        relativePath: state.pathBindings.metadata.relativePath },
      cache: { configured: state.pathBindings.cache.configured, root: state.pathBindings.cache.root,
        relativePath: state.pathBindings.cache.relativePath },
    },
    roots: orderedRoots(state.roots),
  };
}

function calculateIdentityDigest(state) {
  return sha256(JSON.stringify(identityPayload(state)));
}

function assertDiscoveredState(state) {
  plainRecord(state, 'discovered Jellyfin instance state');
  exactKeys(state, ['kind', 'instanceRoot', 'identity', 'paths', 'pathBindings', 'roots'], 'discovered Jellyfin instance state');
  if (state.kind !== instanceStateKind) throw new Error('Invalid discovered Jellyfin instance state');
  plainRecord(state.identity, 'discovered Jellyfin instance identity');
  exactKeys(state.identity, ['algorithm', 'digest', 'serverId', 'criticalFiles', 'databaseGeneration', 'controlGeneration', 'stateGeneration'], 'discovered Jellyfin instance identity');
  exactKeys(state.identity.criticalFiles, ['systemConfiguration', 'networkConfiguration', 'serverIdentity'], 'discovered Jellyfin critical identity');
  if (!isServerIdentity(state.identity.serverId) || state.identity.algorithm !== 'sha256' || !sha256Pattern.test(state.identity.digest)) {
    throw new Error('Invalid discovered Jellyfin instance identity');
  }
  if (Object.values(state.identity.criticalFiles).some(value => !sha256Pattern.test(value))) throw new Error('Invalid discovered Jellyfin critical identity');
  const fullGeneration = plainRecord(state.identity.stateGeneration, 'discovered Jellyfin state generation');
  exactKeys(fullGeneration, ['algorithm', 'digest', 'rootCount', 'directoryCount', 'fileCount', 'bytes'], 'discovered Jellyfin state generation');
  if (fullGeneration.algorithm !== 'sha256' || !sha256Pattern.test(fullGeneration.digest)
    || !Number.isSafeInteger(fullGeneration.rootCount) || fullGeneration.rootCount !== Object.keys(state.roots ?? {}).length
    || !Number.isSafeInteger(fullGeneration.directoryCount) || fullGeneration.directoryCount < fullGeneration.rootCount
    || !Number.isSafeInteger(fullGeneration.fileCount) || fullGeneration.fileCount < 4
    || !/^(?:0|[1-9]\d*)$/u.test(fullGeneration.bytes)) throw new Error('Invalid discovered Jellyfin state generation');
  const generation = plainRecord(state.identity.databaseGeneration, 'discovered Jellyfin database generation');
  exactKeys(generation, ['algorithm', 'digest', 'files'], 'discovered Jellyfin database generation');
  const generationRoles = Array.isArray(generation.files) ? generation.files.map(file => file?.role) : [];
  const roleOrder = generationRoles.map(role => ['sqlite', 'wal', 'shm'].indexOf(role));
  if (generation.algorithm !== 'sha256' || !sha256Pattern.test(generation.digest) || !Array.isArray(generation.files)
    || generation.files.length < 1 || generation.files[0]?.role !== 'sqlite'
    || new Set(generationRoles).size !== generationRoles.length || roleOrder.some((order, index) => order < 0 || (index && order <= roleOrder[index - 1]))
    || generation.files.some(file => !file || Object.keys(file).sort().join(',') !== 'bytes,modifiedAt,role,sha256'
      || !/^(?:0|[1-9]\d*)$/u.test(file.bytes) || !sha256Pattern.test(file.sha256)
      || typeof file.modifiedAt !== 'string' || Number.isNaN(Date.parse(file.modifiedAt))
      || new Date(file.modifiedAt).toISOString() !== file.modifiedAt)
    || generation.digest !== sha256(canonicalJson(generation.files))) throw new Error('Invalid discovered Jellyfin database generation');
  const control = plainRecord(state.identity.controlGeneration, 'discovered Jellyfin control generation');
  exactKeys(control, ['algorithm', 'digest', 'inventory', 'restoredState'], 'discovered Jellyfin control generation');
  if (control.algorithm !== 'sha256' || !sha256Pattern.test(control.digest)
    || !Array.isArray(control.inventory)) {
    throw new Error('Invalid discovered Jellyfin control generation');
  }
  const inventoryNames = new Set(), inventoryRoots = new Set();
  for (const entry of control.inventory) {
    plainRecord(entry, 'discovered Jellyfin top-level inventory entry');
    if (typeof entry.name !== 'string' || !entry.name || path.basename(entry.name) !== entry.name || entry.name === '.' || entry.name === '..'
      || inventoryNames.has(pathKey(entry.name))) throw new Error('Invalid discovered Jellyfin top-level inventory');
    inventoryNames.add(pathKey(entry.name));
    if (entry.kind === 'state-root') {
      exactKeys(entry, ['name', 'kind', 'root'], 'discovered Jellyfin top-level state root');
      if (typeof entry.root !== 'string' || !entry.root || inventoryRoots.has(entry.root)) {
        throw new Error('Invalid discovered Jellyfin top-level inventory');
      }
      inventoryRoots.add(entry.root);
    } else if (entry.kind === 'restored-state') {
      exactKeys(entry, ['name', 'kind'], 'discovered Jellyfin restored-state inventory entry');
      if (entry.name !== 'mediamanager-state.json') throw new Error('Invalid discovered Jellyfin top-level inventory');
    } else throw new Error('Invalid discovered Jellyfin top-level inventory');
  }
  if (control.restoredState !== null) {
    exactKeys(control.restoredState, ['bytes', 'modifiedAt', 'sha256'], 'discovered Jellyfin restored-state generation');
    if (!/^(?:0|[1-9]\d*)$/u.test(control.restoredState.bytes) || !sha256Pattern.test(control.restoredState.sha256)) {
      throw new Error('Invalid discovered Jellyfin restored-state generation');
    }
    canonicalTimestamp(control.restoredState.modifiedAt, 'discovered Jellyfin restored-state generation modifiedAt');
  }
  if (control.digest !== sha256(canonicalJson({ inventory: control.inventory, restoredState: control.restoredState }))) {
    throw new Error('Invalid discovered Jellyfin control generation');
  }
  exactKeys(state.paths, ['programData', 'configuration', 'defaultMetadata', 'metadata', 'defaultCache', 'cache', 'log', 'sqlite'], 'discovered Jellyfin paths');
  plainRecord(state.roots, 'discovered Jellyfin state roots');
  const rootLabels = Object.keys(state.roots), requiredRoots = ['data', 'config', 'cache', 'log'];
  if (requiredRoots.some(label => !rootLabels.includes(label))
    || rootLabels.some(label => ![...requiredRoots, 'metadata-external', 'cache-external'].includes(label))
    || Object.values({ instanceRoot: state.instanceRoot, ...state.paths, ...state.roots }).some(value => typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value)
    || pathKey(state.roots.data) !== pathKey(path.join(state.instanceRoot, 'data'))
    || pathKey(state.roots.config) !== pathKey(path.join(state.instanceRoot, 'config'))
    || pathKey(state.roots.cache) !== pathKey(path.join(state.instanceRoot, 'cache'))
    || pathKey(state.roots.log) !== pathKey(path.join(state.instanceRoot, 'log'))
    || pathKey(state.paths.programData) !== pathKey(state.roots.data)
    || pathKey(state.paths.configuration) !== pathKey(state.roots.config)
    || pathKey(state.paths.defaultCache) !== pathKey(state.roots.cache)
    || pathKey(state.paths.cache) !== pathKey(state.roots['cache-external'] ?? state.paths.cache)
    || (state.roots['cache-external'] == null && !Object.values(state.roots).some(root => pathsOverlap(root, state.paths.cache)))
    || pathKey(state.paths.log) !== pathKey(state.roots.log)
    || pathKey(state.paths.defaultMetadata) !== pathKey(path.join(state.paths.programData, 'metadata'))
    || pathKey(state.paths.sqlite) !== pathKey(path.join(state.paths.programData, 'data', 'jellyfin.db'))
    || (state.roots['metadata-external'] != null && pathKey(state.paths.metadata) !== pathKey(state.roots['metadata-external']))
    || (state.roots['metadata-external'] == null && !Object.values(state.roots).some(root => pathsOverlap(root, state.paths.metadata)))) {
    throw new Error('Invalid discovered Jellyfin path model');
  }
  const rootEntries = Object.entries(state.roots);
  for (let index = 0; index < rootEntries.length; index++) for (let other = index + 1; other < rootEntries.length; other++) {
    if (pathsOverlap(rootEntries[index][1], rootEntries[other][1]) || pathsOverlap(rootEntries[other][1], rootEntries[index][1])) {
      throw new Error('Invalid overlapping discovered Jellyfin state roots');
    }
  }
  const expectedInventoryRoots = rootEntries.filter(([, value]) => pathKey(path.dirname(value)) === pathKey(state.instanceRoot))
    .map(([root, value]) => ({ name: path.basename(value), kind: 'state-root', root }))
    .sort((left, right) => compareText(left.name, right.name));
  const expectedInventory = control.restoredState === null ? expectedInventoryRoots
    : [...expectedInventoryRoots, { name: 'mediamanager-state.json', kind: 'restored-state' }]
      .sort((left, right) => compareText(left.name, right.name));
  if (canonicalJson(control.inventory) !== canonicalJson(expectedInventory)) {
    throw new Error('Invalid discovered Jellyfin top-level inventory');
  }
  plainRecord(state.pathBindings, 'discovered Jellyfin path bindings');
  exactKeys(state.pathBindings, ['metadata', 'cache'], 'discovered Jellyfin path bindings');
  for (const [name, effectivePath] of [['metadata', state.paths.metadata], ['cache', state.paths.cache]]) {
    const binding = plainRecord(state.pathBindings[name], `discovered Jellyfin ${name} path binding`);
    exactKeys(binding, ['configured', 'root', 'relativePath'], `discovered Jellyfin ${name} path binding`);
    const validRelative = typeof binding.relativePath === 'string' && !binding.relativePath.includes('\\')
      && !binding.relativePath.includes(':') && !binding.relativePath.includes('\0') && !path.posix.isAbsolute(binding.relativePath)
      && (binding.relativePath === '' || !binding.relativePath.split('/').some(part => !part || part === '.' || part === '..'));
    const bindingRoot = state.roots[binding.root];
    const reconstructed = bindingRoot && path.resolve(bindingRoot, ...binding.relativePath.split('/').filter(Boolean));
    const defaultPath = name === 'metadata' ? state.paths.defaultMetadata : state.paths.defaultCache;
    if (typeof binding.configured !== 'boolean' || !bindingRoot || !validRelative || pathKey(reconstructed) !== pathKey(effectivePath)
      || (!binding.configured && pathKey(effectivePath) !== pathKey(defaultPath))) {
      throw new Error(`Invalid discovered Jellyfin ${name} path binding`);
    }
  }
  if (calculateIdentityDigest(state) !== state.identity.digest) throw new Error('Discovered Jellyfin instance identity digest does not match its state');
  return state;
}

/** Validate a persisted discovery record without consulting its source paths. */
export function validateInstanceStateSnapshot(discoveredState) {
  return structuredClone(assertDiscoveredState(discoveredState));
}

async function assertCurrentDiscoveredState(state) {
  assertDiscoveredState(state);
  await directoryIdentity(state.instanceRoot, 'instance root');
  for (const [label, stateRoot] of Object.entries(state.roots)) await directoryIdentity(stateRoot, `${label} state root`);
  for (const stateRoot of Object.values(state.roots)) await assertCaptureTree(stateRoot);
  const criticalPaths = {
    systemConfiguration: path.join(state.paths.configuration, 'system.xml'),
    networkConfiguration: path.join(state.paths.configuration, 'network.xml'),
    serverIdentity: path.join(state.paths.programData, 'data', 'device.txt'),
  };
  const criticalFiles = Object.fromEntries(await Promise.all(Object.entries(criticalPaths).map(async ([label, filename]) => {
    await regularFileIdentity(filename, label);
    return [label, await fileSha256(filename)];
  })));
  if (canonicalJson(criticalFiles) !== canonicalJson(state.identity.criticalFiles)) {
    throw new Error('Discovered Jellyfin critical identity is no longer current');
  }
  const currentDatabaseGeneration = await databaseGeneration(state.paths.sqlite);
  if (canonicalJson(currentDatabaseGeneration) !== canonicalJson(state.identity.databaseGeneration)) {
    throw new Error('Discovered Jellyfin SQLite generation is no longer current');
  }
  const currentStateGeneration = await stateGeneration(state.roots);
  if (canonicalJson(currentStateGeneration) !== canonicalJson(state.identity.stateGeneration)) {
    throw new Error('Discovered Jellyfin complete state generation is no longer current');
  }
  const currentControlGeneration = await controlGeneration(state.instanceRoot, state.roots);
  if (canonicalJson(currentControlGeneration) !== canonicalJson(state.identity.controlGeneration)) {
    throw new Error('Discovered MediaManager control generation is no longer current');
  }
  return state;
}

/**
 * Discover every local root needed to capture an isolated Jellyfin instance.
 * The returned discovery record is the sole filesystem input to createStatePackage.
 */
export async function discoverInstanceState({ instanceRoot } = {}) {
  if (typeof instanceRoot !== 'string' || !instanceRoot) throw new Error('An isolated Jellyfin instance root is required');
  const root = await directoryIdentity(instanceRoot, 'instance root');
  const defaultPaths = {
    programData: await directoryIdentity(path.join(root, 'data'), 'program data directory'),
    configuration: await directoryIdentity(path.join(root, 'config'), 'configuration directory'),
    cache: await directoryIdentity(path.join(root, 'cache'), 'cache directory'),
    log: await directoryIdentity(path.join(root, 'log'), 'log directory'),
  };
  const criticalPaths = {
    systemConfiguration: await regularFileIdentity(path.join(defaultPaths.configuration, 'system.xml'), 'system configuration'),
    networkConfiguration: await regularFileIdentity(path.join(defaultPaths.configuration, 'network.xml'), 'network configuration'),
    serverIdentity: await regularFileIdentity(path.join(defaultPaths.programData, 'data', 'device.txt'), 'server identity'),
    sqlite: await regularFileIdentity(path.join(defaultPaths.programData, 'data', 'jellyfin.db'), 'SQLite database'),
  };
  const before = Object.fromEntries(await Promise.all(Object.entries(criticalPaths).filter(([label]) => label !== 'sqlite')
    .map(async ([label, filename]) => [label, await fileSha256(filename)])));
  const databaseBefore = await databaseGeneration(criticalPaths.sqlite);
  const settings = await inspectInstanceConfiguration(root);
  if (!isServerIdentity(settings.serverId)) throw new Error('The instance server identity is invalid');
  const defaultMetadata = path.join(defaultPaths.programData, 'metadata');
  const metadataConfigured = typeof settings.configuration.MetadataPath === 'string' && Boolean(settings.configuration.MetadataPath.trim());
  const cacheConfigured = typeof settings.configuration.CachePath === 'string' && Boolean(settings.configuration.CachePath.trim());
  const effectiveMetadata = await directoryIdentity(configuredPath(settings.configuration.MetadataPath, defaultMetadata, 'Jellyfin MetadataPath'), 'metadata directory');
  const effectiveCache = await directoryIdentity(configuredPath(settings.configuration.CachePath, defaultPaths.cache, 'Jellyfin CachePath'), 'effective cache directory');
  const roots = { data: defaultPaths.programData, config: defaultPaths.configuration, cache: defaultPaths.cache, log: defaultPaths.log };
  const coreRoots = Object.values(roots);
  const covered = candidate => coreRoots.some(stateRoot => pathsOverlap(stateRoot, candidate));
  if (!covered(effectiveMetadata)) roots['metadata-external'] = effectiveMetadata;
  if (!covered(effectiveCache)) roots['cache-external'] = effectiveCache;
  const rootEntries = Object.entries(roots);
  for (let index = 0; index < rootEntries.length; index++) for (let other = index + 1; other < rootEntries.length; other++) {
    const [leftLabel, left] = rootEntries[index], [rightLabel, right] = rootEntries[other];
    if (pathsOverlap(left, right) || pathsOverlap(right, left)) throw new Error(`Jellyfin state roots overlap: ${leftLabel} and ${rightLabel}`);
  }
  const controlBefore = await controlGeneration(root, roots);
  for (const stateRoot of Object.values(roots)) await assertCaptureTree(stateRoot);
  const fullStateBefore = await stateGeneration(roots);
  const after = Object.fromEntries(await Promise.all(Object.entries(criticalPaths).filter(([label]) => label !== 'sqlite')
    .map(async ([label, filename]) => [label, await fileSha256(filename)])));
  const databaseAfter = await databaseGeneration(criticalPaths.sqlite);
  if (canonicalJson(before) !== canonicalJson(after)) throw new Error('Jellyfin critical identity changed during state discovery');
  if (canonicalJson(databaseBefore) !== canonicalJson(databaseAfter)) throw new Error('Jellyfin SQLite generation changed during state discovery');
  const fullStateAfter = await stateGeneration(roots);
  if (canonicalJson(fullStateBefore) !== canonicalJson(fullStateAfter)) throw new Error('Jellyfin complete state changed during state discovery');
  const rawServerId = decodeServerIdentity(await readFile(criticalPaths.serverIdentity));
  if (rawServerId !== settings.serverId) throw new Error('Jellyfin server identity changed during state discovery');
  const controlAfter = await controlGeneration(root, roots);
  if (canonicalJson(controlBefore) !== canonicalJson(controlAfter)) throw new Error('MediaManager control generation changed during state discovery');
  const serverId = settings.serverId;
  const state = {
    kind: instanceStateKind,
    instanceRoot: root,
    identity: { algorithm: 'sha256', digest: '', serverId, criticalFiles: before,
      databaseGeneration: databaseBefore, controlGeneration: controlBefore, stateGeneration: fullStateBefore },
    paths: { programData: defaultPaths.programData, configuration: defaultPaths.configuration,
      defaultMetadata: path.resolve(defaultMetadata), metadata: effectiveMetadata, defaultCache: defaultPaths.cache,
      cache: effectiveCache, log: defaultPaths.log, sqlite: criticalPaths.sqlite },
    pathBindings: {
      metadata: pathBinding(roots, effectiveMetadata, metadataConfigured, 'metadata'),
      cache: pathBinding(roots, effectiveCache, cacheConfigured, 'cache'),
    },
    roots,
  };
  state.identity.digest = calculateIdentityDigest(state);
  return state;
}

/** Validate persisted barrier structure without consulting its source paths. */
export function validateWriteBarrierSnapshot(writeBarrier, discoveredState) {
  const state = assertDiscoveredState(discoveredState);
  plainRecord(writeBarrier, 'write barrier');
  const commonKeys = ['kind', 'identityDigest', 'recordedAt'];
  if (!['stopped-service', 'isolated-offline-copy'].includes(writeBarrier.kind)
    || writeBarrier.identityDigest !== state.identity.digest) throw new Error('Invalid or unbound write barrier');
  canonicalTimestamp(writeBarrier.recordedAt, 'write barrier recordedAt');
  if (writeBarrier.kind === 'stopped-service') {
    exactKeys(writeBarrier, [...commonKeys, 'ownedProcess'], 'stopped-service write barrier');
    exactKeys(writeBarrier.ownedProcess, ['pid', 'shutdown', 'forced', 'exitCode', 'signalCode', 'stopped'], 'owned stopped process proof');
    exactKeys(writeBarrier.ownedProcess.shutdown, ['kind', 'statusCode'], 'owned process shutdown proof');
    const process = writeBarrier.ownedProcess;
    if (!Number.isSafeInteger(process.pid) || process.pid < 1 || process.shutdown.kind !== 'http' || process.shutdown.statusCode !== 204
      || process.forced !== false || process.exitCode !== 0 || process.signalCode !== null || process.stopped !== true) {
      throw new Error('Stopped-service barrier requires a clean HTTP 204 shutdown of the owned process');
    }
  } else {
    exactKeys(writeBarrier, [...commonKeys, 'isolatedCopy'], 'isolated-offline-copy write barrier');
    exactKeys(writeBarrier.isolatedCopy, ['owner', 'source'], 'isolated offline copy proof');
    exactKeys(writeBarrier.isolatedCopy.owner, ['kind', 'id'], 'isolated offline copy owner');
    exactKeys(writeBarrier.isolatedCopy.source, ['identityDigest', 'serverId'], 'isolated offline copy source identity');
    const { owner, source } = writeBarrier.isolatedCopy;
    if (owner.kind !== 'test-fixture' || typeof owner.id !== 'string' || !owner.id.trim()
      || source.identityDigest !== state.identity.digest || source.serverId !== state.identity.serverId) {
      throw new Error('Isolated offline copy barrier requires test ownership and a source identity');
    }
  }
  return structuredClone(writeBarrier);
}

/** Validate a write barrier and prove its discovered source state is still current. */
export async function validateWriteBarrier(writeBarrier, discoveredState) {
  const state = await assertCurrentDiscoveredState(discoveredState);
  return validateWriteBarrierSnapshot(writeBarrier, state);
}
