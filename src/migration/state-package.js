import { createHash, randomUUID } from 'node:crypto';
import { decodeServerIdentity } from '../core/server-identity.js';
import { mkdir, readdir, lstat, rename, unlink, lutimes, realpath, open, mkdtemp, rmdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { exportCurrentSqlite, databaseDigest, getNativeEnvelope } from './database-transfer.js';
import { verifyPostgresTransferContract } from '../database/postgres-transfer-contract.js';
import { SqliteDatabase } from '../database/sqlite.js';
import { captureRemoteAssets, inspectRemoteAssets, verifyRemoteGeneration, restoreRemoteAssets, validateRemoteAssetManifest } from './remote-assets.js';
import { validateMediaAccessPlan } from './media-access.js';
import { calculateStateGeneration, validateInstanceStateSnapshot, validateWriteBarrier, validateWriteBarrierSnapshot } from './instance-state.js';
import { assertCaptureSessionHeld } from './capture-session.js';
import { acquireOperationLease } from './operation-lease.js';
import { assertPortableMountRetarget, canonicalPortableMountContract,
  projectPortableJellyfinPath } from '../storage/portable-mount-contract.js';
import { createSqliteExportPathProjector } from './sqlite-export-paths.js';
import { captureLiveTvState, validateLiveTvState } from './live-tv-state.js';

const sha256Value = value => createHash('sha256').update(value).digest('hex');
const normalizeThrown = (value, label) => value instanceof Error ? value : new Error(`${label}: ${String(value)}`, { cause: value });
const dateFromNanoseconds = value => new Date(Number(value / 1_000_000n));
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const pathIdentity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const safeRelative = (value) => typeof value === 'string' && value && !value.includes('\\') && !value.includes(':') && !value.includes('\0') && !path.posix.isAbsolute(value) && !value.split('/').some((part) => part === '..' || part === '.' || part === '');
const restoredStatePath = 'mediamanager-state.json';
const restoredStateTemporaryPath = 'mediamanager-state.json.tmp';
const committedTemporaryPath = 'COMMITTED.tmp';
const manifestTemporaryPath = 'manifest.json.tmp';
const reservedStatePaths = [restoredStatePath, restoredStateTemporaryPath, 'COMMITTED', committedTemporaryPath,
  'manifest.json', manifestTemporaryPath, 'progress.json', 'progress.json.tmp'];
const controlFileLimits = Object.freeze({
  manifest: 64 * 1024 * 1024,
  commit: 64 * 1024,
  progress: 1024 * 1024,
  restoredState: 4 * 1024 * 1024,
  systemConfiguration: 8 * 1024 * 1024,
});
const readOnlyNoFollowFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const createExclusiveNoFollowFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0);
const atomicTemporaryPattern = /^\.(.+)\.mediamanager-tmp-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/iu;
const databaseExportStagingName = '.jellyfin.db.tmp.mediamanager-export-staging';
const databaseExportStagingFiles = new Set([databaseExportStagingName,
  `${databaseExportStagingName}-journal`, `${databaseExportStagingName}-wal`, `${databaseExportStagingName}-shm`]);
const pathsCollide = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

function fileGeneration(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function assertPhysicalDirectory(root, directory, label) {
  root = path.resolve(root); directory = path.resolve(directory);
  if (!inside(root, directory)) throw new Error(`${label} escapes its trusted root`);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error(`${label} root is not a physical directory`);
  const physicalRoot = await realpath(root);
  if (pathIdentity(physicalRoot) !== pathIdentity(root)) throw new Error(`${label} root must not use a symbolic-link or junction path`);
  const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} parent is not a physical directory`);
    const expected = path.resolve(physicalRoot, ...path.relative(root, current).split(path.sep).filter(Boolean));
    if (pathIdentity(await realpath(current)) !== pathIdentity(expected)) throw new Error(`${label} parent must not use a symbolic link or junction`);
  }
  return physicalRoot;
}

async function openRegularForRead(root, filename, label) {
  root = path.resolve(root); filename = path.resolve(filename);
  if (!inside(root, filename) || filename === root) throw new Error(`${label} escapes its trusted root`);
  await assertPhysicalDirectory(root, path.dirname(filename), label);
  let handle;
  try { handle = await open(filename, readOnlyNoFollowFlags); }
  catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error.code)) throw new Error(`${label} must not be a symbolic link`, { cause: error });
    throw error;
  }
  try {
    const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(filename, { bigint: true })]);
    if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || !sameFile(opened, named)) {
      throw new Error(`${label} changed while it was opened or is not a regular file`);
    }
    await assertPhysicalDirectory(root, path.dirname(filename), label);
    return { handle, metadata: opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function consumeOpenedFile(opened, label, { maxBytes = Number.MAX_SAFE_INTEGER, collect = false, onChunk } = {}) {
  if (opened.metadata.size > BigInt(maxBytes)) throw new Error(`${label} exceeds its size limit`);
  const hash = createHash('sha256'), chunks = collect ? [] : undefined;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0, position = 0;
  for (;;) {
    const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    bytes += bytesRead; position += bytesRead;
    if (bytes > maxBytes) throw new Error(`${label} exceeds its size limit`);
    const chunk = buffer.subarray(0, bytesRead);
    hash.update(chunk);
    if (collect) chunks.push(Buffer.from(chunk));
    await onChunk?.(chunk);
  }
  const after = await opened.handle.stat({ bigint: true });
  if (fileGeneration(after) !== fileGeneration(opened.metadata)) throw new Error(`${label} changed while it was read`);
  return { bytes, buffer: collect ? Buffer.concat(chunks, bytes) : undefined, sha256: hash.digest('hex') };
}

async function inspectRegularFile(root, filename, label, { expectedBytes, expectedSha256 } = {}) {
  const opened = await openRegularForRead(root, filename, label);
  try {
    const maximum = expectedBytes ?? Number.MAX_SAFE_INTEGER;
    const result = await consumeOpenedFile(opened, label, { maxBytes: maximum });
    if (expectedBytes != null && result.bytes !== expectedBytes || expectedSha256 != null && result.sha256 !== expectedSha256) {
      throw new Error(`${label} checksum mismatch`);
    }
    return { ...result, metadata: opened.metadata };
  } finally { await opened.handle.close(); }
}

async function readRegularFileBounded(root, filename, limit, label) {
  const opened = await openRegularForRead(root, filename, label);
  try { return await consumeOpenedFile(opened, label, { maxBytes: limit, collect: true }); }
  finally { await opened.handle.close(); }
}

async function readVerifiedRegularFile(root, filename, limit, label, { expectedBytes, expectedSha256 } = {}) {
  const result = await readRegularFileBounded(root, filename, limit, label);
  if (expectedBytes != null && result.bytes !== expectedBytes || expectedSha256 != null && result.sha256 !== expectedSha256) {
    throw new Error(`${label} checksum mismatch`);
  }
  return result;
}

async function readJsonBounded(root, filename, limit, label) {
  const result = await readRegularFileBounded(root, filename, limit, label);
  try { return { ...result, value: JSON.parse(result.buffer.toString('utf8')) }; }
  catch (error) { throw new Error(`${label} is not valid JSON`, { cause: error }); }
}

async function writeFully(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw new Error('Unable to complete an atomic state package write');
    offset += bytesWritten;
  }
}

async function inspectOptionalTarget(filename, label) {
  try {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`${label} target is not a regular file`);
    return metadata;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function atomicInstall(root, filename, label, writer, { accessedAt, modifiedAt } = {}) {
  root = path.resolve(root); filename = path.resolve(filename);
  if (!inside(root, filename) || filename === root) throw new Error(`${label} target escapes its trusted root`);
  const parent = path.dirname(filename);
  await assertPhysicalDirectory(root, parent, label);
  const temporary = path.join(parent, `.${path.basename(filename)}.mediamanager-tmp-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, createExclusiveNoFollowFlags, 0o600);
    await writer(handle);
    if (modifiedAt) await handle.utimes(accessedAt ?? modifiedAt, modifiedAt);
    await handle.sync();
    await handle.close(); handle = undefined;
    await assertPhysicalDirectory(root, parent, label);
    await inspectOptionalTarget(filename, label);
    await rename(temporary, filename);
    await assertPhysicalDirectory(root, parent, label);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    try { await unlink(temporary); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw new AggregateError([error, cleanupError], `${label} failed and its temporary file could not be removed`); }
    throw error;
  }
}

async function atomicWriteBuffer(root, filename, buffer, label, options) {
  await atomicInstall(root, filename, label, handle => writeFully(handle, buffer), options);
}

async function atomicCopyVerified(sourceRoot, sourceFilename, destinationRoot, destinationFilename, label,
  { expectedBytes, expectedSha256, accessedAt, modifiedAt } = {}) {
  const source = await openRegularForRead(sourceRoot, sourceFilename, `${label} source`);
  try {
    if (expectedBytes != null && source.metadata.size !== BigInt(expectedBytes)) throw new Error(`${label} source checksum mismatch`);
    let copied;
    await atomicInstall(destinationRoot, destinationFilename, label, async target => {
      copied = await consumeOpenedFile(source, `${label} source`, {
        maxBytes: expectedBytes ?? Number.MAX_SAFE_INTEGER,
        onChunk: chunk => writeFully(target, chunk),
      });
      if (expectedBytes != null && copied.bytes !== expectedBytes || expectedSha256 != null && copied.sha256 !== expectedSha256) {
        throw new Error(`${label} source checksum mismatch`);
      }
    }, { accessedAt, modifiedAt });
    return copied;
  } finally { await source.handle.close(); }
}

async function ensurePhysicalDirectory(root, directory, label) {
  root = path.resolve(root); directory = path.resolve(directory);
  if (!inside(root, directory)) throw new Error(`${label} escapes its trusted root`);
  if (directory === root) return assertPhysicalDirectory(root, root, label);
  await assertPhysicalDirectory(root, path.dirname(directory), label);
  try { await mkdir(directory, { recursive: false }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return assertPhysicalDirectory(root, directory, label);
}

function atomicTemporaryTarget(relative) {
  const normalized = relative.split(path.sep).join('/'), basename = path.posix.basename(normalized);
  const match = atomicTemporaryPattern.exec(basename);
  if (!match) return undefined;
  const parent = path.posix.dirname(normalized);
  return parent === '.' ? match[1] : `${parent}/${match[1]}`;
}

async function removeStaleRegularFile(root, relative, label) {
  const filename = path.join(root, ...relative.split('/'));
  await assertPhysicalDirectory(root, path.dirname(filename), label);
  const opened = await openRegularForRead(root, filename, label);
  const generation = fileGeneration(opened.metadata);
  await opened.handle.close();
  const current = await lstat(filename, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || fileGeneration(current) !== generation) {
    throw new Error(`${label} changed before cleanup`);
  }
  await unlink(filename);
  await assertPhysicalDirectory(root, path.dirname(filename), label);
}

async function prospectivePhysicalPath(value, label) {
  const resolved = path.resolve(value), suffix = [];
  let existing = resolved, metadata;
  for (;;) {
    try { metadata = await lstat(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`${label} has no existing filesystem ancestor`);
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (suffix.length && !metadata.isDirectory()) throw new Error(`${label} parent is not a directory`);
  const physical = path.resolve(await realpath(existing), ...suffix);
  if (pathIdentity(physical) !== pathIdentity(resolved)) throw new Error(`${label} must not use a symbolic-link or junction parent`);
  return physical;
}
function validateAssetRestorePaths(assetPaths) {
  for (const value of assetPaths) {
    if (!safeRelative(value)) throw new Error('Invalid state asset restore path');
    const key = value.toLowerCase();
    for (const reserved of reservedStatePaths) if (pathsCollide(key, reserved.toLowerCase()))
      throw new Error(`State asset path collides with reserved state path: ${reserved}`);
  }
}
function validateDatabaseRestorePath(value, assetPaths = []) {
  if (!safeRelative(value)) throw new Error('Invalid database restore path');
  const key = value.toLowerCase();
  for (const entry of [...reservedStatePaths, ...assetPaths]) {
    const other = entry.toLowerCase();
    if (pathsCollide(key, other))
      throw new Error(`Database restore path collides with state path: ${entry}`);
  }
}
function relativeParents(value) {
  const parts = value.split('/'), result = [];
  for (let index = 1; index < parts.length; index++) result.push(parts.slice(0, index).join('/'));
  return result;
}
function validateFileManifest(files, { remote }) {
  if (!Array.isArray(files)) throw new Error('State package file manifest is required');
  const seen = new Set();
  for (const file of files) {
    const expectedKeys = remote ? 'bytes,modifiedAt,path,remote,sha256' : 'bytes,modifiedAt,path,sha256';
    if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).sort().join(',') !== expectedKeys
      || !safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || (file.modifiedAt != null && (typeof file.modifiedAt !== 'string' || Number.isNaN(Date.parse(file.modifiedAt))
        || new Date(file.modifiedAt).toISOString() !== file.modifiedAt))) throw new Error('Invalid state package file declaration');
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate state package file path');
    seen.add(key);
  }
}
function validateDirectoryManifest(directories, files, databaseRestorePath) {
  if (!Array.isArray(directories)) throw new Error('State package directory manifest is required');
  const seen = new Set(), filePaths = new Set(files.map(file => file.path.toLowerCase()));
  for (const directory of directories) {
    if (!directory || typeof directory !== 'object' || Array.isArray(directory)
      || Object.keys(directory).sort().join(',') !== 'modifiedAt,path'
      || !safeRelative(directory.path) || filePaths.has(directory.path.toLowerCase())
      || (directory.modifiedAt != null && (typeof directory.modifiedAt !== 'string'
        || Number.isNaN(Date.parse(directory.modifiedAt)) || new Date(directory.modifiedAt).toISOString() !== directory.modifiedAt))) {
      throw new Error('Invalid state package directory declaration');
    }
    const key = directory.path.toLowerCase();
    const databaseKey = databaseRestorePath.toLowerCase();
    if (key === databaseKey || key.startsWith(`${databaseKey}/`)) throw new Error('State package directory collides with database restore path');
    if (seen.has(key)) throw new Error('Duplicate state package directory path');
    seen.add(key);
  }
  validateAssetRestorePaths(directories.map(directory => directory.path));
  for (const file of files.filter(file => !file.remote)) for (const parent of relativeParents(file.path)) {
    if (!seen.has(parent.toLowerCase())) throw new Error(`State package file parent directory is missing: ${parent}`);
  }
  for (const directory of directories) for (const parent of relativeParents(directory.path)) {
    if (!seen.has(parent.toLowerCase())) throw new Error(`State package parent directory is missing: ${parent}`);
  }
  for (const parent of relativeParents(databaseRestorePath)) {
    if (!seen.has(parent.toLowerCase())) throw new Error(`Database restore parent directory is missing: ${parent}`);
  }
  return seen;
}
function expectedDatabaseRestorePath(instanceState) {
  const containingRoots = Object.entries(instanceState.roots)
    .filter(([, root]) => inside(path.resolve(root), path.resolve(instanceState.paths.sqlite)));
  if (containingRoots.length !== 1) throw new Error('Discovered SQLite database must belong to exactly one state root');
  const [label, root] = containingRoots[0];
  const relative = path.relative(root, instanceState.paths.sqlite).split(path.sep).join('/');
  const restorePath = `${label}/${relative}`;
  if (!safeRelative(restorePath)) throw new Error('Discovered SQLite database has an invalid restore path');
  return restorePath;
}
function validateExcludedDatabaseFiles(excluded, instanceState) {
  if (!Array.isArray(excluded) || excluded.some(value => !safeRelative(value))) throw new Error('Invalid excluded database file manifest');
  const containingRoots = Object.entries(instanceState.roots).filter(([, root]) => inside(path.resolve(root), path.resolve(instanceState.paths.sqlite)));
  if (containingRoots.length !== 1) throw new Error('Discovered SQLite database must belong to exactly one state root');
  const [label, root] = containingRoots[0];
  const relative = path.relative(root, instanceState.paths.sqlite).split(path.sep).join('/');
  const suffix = { sqlite: '', wal: '-wal', shm: '-shm' };
  const expected = instanceState.identity.databaseGeneration.files.map(file => `${label}/${relative}${suffix[file.role]}`)
    .map(value => value.toLowerCase()).sort();
  const actual = excluded.map(value => value.toLowerCase()).sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error('Excluded database files do not match the discovered SQLite generation');
  }
}

function stateRecordPath(packagePath, rootLabels) {
  const [label, ...parts] = packagePath.split('/');
  if (!rootLabels.includes(label)) throw new Error(`State package path is outside the discovered roots: ${packagePath}`);
  return { label, path: parts.join('/') };
}

function validatePackagedStateGeneration(manifest, instanceState) {
  const rootLabels = Object.keys(instanceState.roots);
  const records = [
    ...manifest.directories.map(directory => ({ ...stateRecordPath(directory.path, rootLabels), kind: 'directory',
      modifiedAt: directory.modifiedAt })),
    ...manifest.instanceFiles.map(file => ({ ...stateRecordPath(file.path, rootLabels), kind: 'file',
      bytes: file.bytes.toString(), modifiedAt: file.modifiedAt, sha256: file.sha256 })),
  ];
  const containingRoots = Object.entries(instanceState.roots).filter(([, root]) => inside(path.resolve(root), path.resolve(instanceState.paths.sqlite)));
  if (containingRoots.length !== 1) throw new Error('Discovered SQLite database must belong to exactly one state root');
  const [databaseLabel, databaseRoot] = containingRoots[0];
  const databaseRelative = path.relative(databaseRoot, instanceState.paths.sqlite).split(path.sep).join('/');
  const suffix = { sqlite: '', wal: '-wal', shm: '-shm' };
  for (const file of instanceState.identity.databaseGeneration.files) records.push({ label: databaseLabel,
    path: `${databaseRelative}${suffix[file.role]}`, kind: 'file', bytes: file.bytes,
    modifiedAt: file.modifiedAt, sha256: file.sha256 });
  const actual = calculateStateGeneration(rootLabels, records);
  if (JSON.stringify(actual) !== JSON.stringify(instanceState.identity.stateGeneration)) {
    throw new Error(`State package files do not reconstruct the discovered complete state generation: ${JSON.stringify(actual)} != ${JSON.stringify(instanceState.identity.stateGeneration)}`);
  }
}

async function validatePackagedPathBindings(directory, instanceState, systemFile) {
  const filename = path.join(directory, 'files', 'config', 'system.xml');
  if (!systemFile) throw new Error('State package is missing the native system configuration');
  const xml = (await readVerifiedRegularFile(directory, filename, controlFileLimits.systemConfiguration,
    'State package native system configuration', { expectedBytes: systemFile.bytes, expectedSha256: systemFile.sha256 })).buffer.toString('utf8');
  if (XMLValidator.validate(xml) !== true) throw new Error('State package native system configuration is invalid XML');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(xml)?.ServerConfiguration;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('State package native system configuration is invalid');
  for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
    const binding = instanceState.pathBindings[name], value = parsed[field];
    const configured = typeof value === 'string' && Boolean(value.trim());
    if (configured !== binding.configured || configured && pathIdentity(value) !== pathIdentity(instanceState.paths[name])) {
      throw new Error(`State package ${field} does not match its discovered path binding`);
    }
    if (configured) {
      const expression = new RegExp(`<${field}>[\\s\\S]*?<\\/${field}>`, 'gu');
      if ([...xml.matchAll(expression)].length !== 1) throw new Error(`State package configured ${field} is not a single simple XML element`);
    }
  }
}
async function inventoryUnder(root, relative = '') {
  const directory = path.join(root, relative);
  await assertPhysicalDirectory(root, directory, 'State inventory');
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [], directories = [];
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const current = path.join(relative, entry.name);
    const metadata = await lstat(path.join(root, current));
    if (metadata.isSymbolicLink()) throw new Error(`State package refuses symbolic links: ${current}`);
    if (entry.isDirectory()) {
      directories.push(current);
      const nested = await inventoryUnder(root, current);
      directories.push(...nested.directories); files.push(...nested.files);
    } else if (entry.isFile()) files.push(current);
    else throw new Error(`Unsupported state file: ${current}`);
  }
  await assertPhysicalDirectory(root, directory, 'State inventory');
  return { files, directories };
}
async function journal(destination, value) {
  await writeJsonAtomic(destination, 'progress.json', 'progress.json.tmp', value);
}

async function validatePackageControlInventory(directory) {
  const expected = new Map([['COMMITTED', 'file'], ['files', 'directory'], ['jellyfin.db', 'file'], ['manifest.json', 'file'], ['progress.json', 'file']]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length !== expected.size) throw new Error('State package control inventory is incomplete or contains unlisted entries');
  for (const entry of entries) {
    const kind = expected.get(entry.name), metadata = await lstat(path.join(directory, entry.name));
    if (!kind || metadata.isSymbolicLink() || (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new Error(`Invalid state package control entry: ${entry.name}`);
    }
  }
}

async function validateCaptureControlInventory(directory) {
  await assertPhysicalDirectory(directory, directory, 'State package capture staging');
  const allowed = new Map([['COMMITTED', 'file'], [committedTemporaryPath, 'file'], ['files', 'directory'], ['jellyfin.db', 'file'], ['jellyfin.db.tmp', 'file'],
    ['manifest.json', 'file'], [manifestTemporaryPath, 'file'], ['progress.json', 'file'], ['progress.json.tmp', 'file']]);
  const atomicTargets = new Set(['committed', 'manifest.json', 'progress.json']);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const atomicTarget = atomicTemporaryTarget(entry.name)?.toLowerCase();
    if (atomicTarget && atomicTargets.has(atomicTarget)) {
      await removeStaleRegularFile(directory, entry.name, `State package capture temporary entry ${entry.name}`);
      continue;
    }
    if (databaseExportStagingFiles.has(entry.name)) {
      await removeStaleRegularFile(directory, entry.name, `State package database export temporary entry ${entry.name}`);
      continue;
    }
    const kind = allowed.get(entry.name), metadata = await lstat(path.join(directory, entry.name));
    if (!kind || metadata.isSymbolicLink() || (kind === 'file' ? !metadata.isFile() : !metadata.isDirectory())) {
      throw new Error(`Invalid state package capture staging entry: ${entry.name}`);
    }
  }
}

async function removeOptionalRegularFile(filename) {
  let metadata;
  try { metadata = await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`State package capture temporary path is not a regular file: ${filename}`);
  await unlink(filename);
}

async function readOptionalJson(root, filename, limit, label) {
  try { return (await readJsonBounded(root, path.join(root, filename), limit, label)).value; }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function writeJsonAtomic(directory, filename, temporaryFilename, value) {
  const limits = { 'manifest.json': controlFileLimits.manifest, COMMITTED: controlFileLimits.commit,
    'progress.json': controlFileLimits.progress, [restoredStatePath]: controlFileLimits.restoredState };
  const limit = limits[filename];
  if (limit == null) throw new Error(`Unknown atomic state package JSON control file: ${filename}`);
  const serialized = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (serialized.length > limit) throw new Error(`${filename} exceeds its size limit`);
  // Fixed temporary names from an interrupted write are reserved and removed before using a fresh unpredictable name.
  await assertPhysicalDirectory(directory, directory, filename);
  await removeOptionalRegularFile(path.join(directory, temporaryFilename));
  await atomicWriteBuffer(directory, path.join(directory, filename), serialized, filename);
}

function restoreStagingPath(destination, generation) {
  const parent = path.dirname(destination), name = path.basename(destination);
  if (!name || parent === destination) throw new Error('Restore destination must not be a filesystem root');
  return path.join(parent, `.${name}.mediamanager-restore-${generation}`);
}

function packageStagingPath(destination) {
  const parent = path.dirname(destination), name = path.basename(destination);
  if (!name || parent === destination) throw new Error('State package destination must not be a filesystem root');
  return path.join(parent, `.${name}.mediamanager-package-staging`);
}

async function withOperationLease(identity, label, operation) {
  const lease = await acquireOperationLease(identity, { label });
  let result, operationError, failed = false;
  try { result = await operation(lease); }
  catch (error) { operationError = error; failed = true; }
  try { await lease.release(); }
  catch (releaseError) {
    if (failed) {
      const cause = normalizeThrown(operationError, `${label} failed`);
      throw new AggregateError([cause, releaseError], `${label} failed and its lease could not be released`, { cause });
    }
    throw releaseError;
  }
  if (failed) throw operationError;
  return result;
}

function canonicalJson(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('State package capture inputs must contain finite JSON numbers');
    return JSON.stringify(value);
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('State package capture inputs must be acyclic JSON values');
  seen.add(value);
  let result;
  if (Array.isArray(value)) result = `[${value.map(entry => canonicalJson(entry, seen)).join(',')}]`;
  else result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function validateCaptureProgress(progress, expected) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)
    || Object.keys(progress).sort().join(',') !== 'destination,generation,kind,lastError,requestSha256,sourceSha256,stage,startedAt,updatedAt'
    || progress.kind !== 'state-package-capture'
    || typeof progress.generation !== 'string' || !/^[a-f0-9-]{36}$/iu.test(progress.generation)
    || typeof progress.destination !== 'string' || !path.isAbsolute(progress.destination) || path.resolve(progress.destination) !== progress.destination
    || !/^[a-f0-9]{64}$/u.test(progress.requestSha256) || !/^[a-f0-9]{64}$/u.test(progress.sourceSha256)
    || expected.destination !== undefined && pathIdentity(progress.destination) !== pathIdentity(expected.destination)
    || progress.requestSha256 !== expected.requestSha256
    || progress.sourceSha256 !== expected.sourceSha256 || !['preflight', 'files-captured', 'database-captured', 'verified'].includes(progress.stage)
    || typeof progress.startedAt !== 'string' || Number.isNaN(Date.parse(progress.startedAt))
    || new Date(progress.startedAt).toISOString() !== progress.startedAt
    || typeof progress.updatedAt !== 'string' || Number.isNaN(Date.parse(progress.updatedAt))
    || new Date(progress.updatedAt).toISOString() !== progress.updatedAt
    || (progress.lastError !== null && typeof progress.lastError !== 'string')) {
    throw new Error('State package capture staging does not match the current request and source generation');
  }
  return progress;
}

function restoredBindingPath(manifest, destination, name) {
  const binding = manifest.instanceState.pathBindings[name];
  return path.join(destination, binding.root, ...binding.relativePath.split('/').filter(Boolean));
}

function rewriteConfiguredPath(xml, tag, value) {
  const expression = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gu');
  const matches = [...xml.matchAll(expression)];
  if (matches.length !== 1) throw new Error(`Configured Jellyfin ${tag} must have exactly one simple XML element`);
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return xml.replace(expression, `<${tag}>${escaped}</${tag}>`);
}

async function createRestorePlan(packageDirectory, manifest, destination) {
  if (manifest.database.restorePath !== expectedDatabaseRestorePath(manifest.instanceState)) {
    throw new Error('State package database restore path differs from the discovered native database path');
  }
  const files = [
    ...manifest.instanceFiles.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, modifiedAt: file.modifiedAt,
      source: ['files', ...file.path.split('/')] })),
    { path: manifest.database.restorePath, sha256: manifest.database.sha256, source: [manifest.database.path] },
  ];
  const system = files.find(file => file.path === 'config/system.xml');
  if (!system) throw new Error('State package is missing the native system configuration');
  if (manifest.instanceState.pathBindings.metadata.configured || manifest.instanceState.pathBindings.cache.configured) {
    let xml = (await readVerifiedRegularFile(packageDirectory, path.join(packageDirectory, ...system.source),
      controlFileLimits.systemConfiguration, 'State package native system configuration',
      { expectedBytes: system.bytes, expectedSha256: system.sha256 })).buffer.toString('utf8');
    if (manifest.instanceState.pathBindings.metadata.configured) {
      xml = rewriteConfiguredPath(xml, 'MetadataPath', restoredBindingPath(manifest, destination, 'metadata'));
    }
    if (manifest.instanceState.pathBindings.cache.configured) {
      xml = rewriteConfiguredPath(xml, 'CachePath', restoredBindingPath(manifest, destination, 'cache'));
    }
    system.content = Buffer.from(xml, 'utf8');
    system.bytes = system.content.length;
    system.sha256 = sha256Value(system.content);
  }
  const systemConfigurationSha256 = system.sha256;
  const layoutSha256 = sha256Value(JSON.stringify({ destination, pathBindings: manifest.instanceState.pathBindings,
    systemConfigurationSha256 }));
  return { files, directories: manifest.directories, systemConfigurationSha256, layoutSha256 };
}

function restoredState(manifest, destination, stage, manifestSha256, plan) {
  return {
    generation: manifest.generation,
    manifestSha256,
    layoutSha256: plan.layoutSha256,
    systemConfigurationSha256: plan.systemConfigurationSha256,
    destination,
    stage,
    database: { restorePath: manifest.database.restorePath, sha256: manifest.database.sha256 },
    extensionStateSha256: sha256Value(canonicalJson(manifest.extensionState)),
    mediaAccessSha256: sha256Value(canonicalJson(manifest.mediaAccess)),
  };
}

function validateRestoredState(value, manifest, destination, expectedStage, manifestSha256, plan) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'database,destination,extensionStateSha256,generation,layoutSha256,manifestSha256,mediaAccessSha256,stage,systemConfigurationSha256'
    || !value.database || Object.keys(value.database).sort().join(',') !== 'restorePath,sha256'
    || !/^[a-f0-9]{64}$/u.test(value.manifestSha256) || !/^[a-f0-9]{64}$/u.test(value.layoutSha256)
    || !/^[a-f0-9]{64}$/u.test(value.systemConfigurationSha256)
    || !/^[a-f0-9]{64}$/u.test(value.extensionStateSha256) || !/^[a-f0-9]{64}$/u.test(value.mediaAccessSha256)
    || value.generation !== manifest.generation
    || value.manifestSha256 !== manifestSha256 || value.destination !== destination || value.stage !== expectedStage
    || value.layoutSha256 !== plan.layoutSha256 || value.systemConfigurationSha256 !== plan.systemConfigurationSha256
    || value.database?.restorePath !== manifest.database.restorePath || value.database?.sha256 !== manifest.database.sha256
    || value.extensionStateSha256 !== sha256Value(canonicalJson(manifest.extensionState))
    || value.mediaAccessSha256 !== sha256Value(canonicalJson(manifest.mediaAccess))) {
    throw new Error('Restore state does not match the requested package generation and destination');
  }
}

async function assertRestoreInventory(directory, allowedPaths, allowedDirectories, { atomicTargets = [] } = {}) {
  let inventory = await inventoryUnder(directory);
  const cleanupTargets = new Set(atomicTargets.map(value => value.toLowerCase()));
  const stale = inventory.files.filter(relative => {
    const target = atomicTemporaryTarget(relative);
    return target && cleanupTargets.has(target.toLowerCase());
  });
  for (const relative of stale) await removeStaleRegularFile(directory, relative.split(path.sep).join('/'),
    `Restore temporary entry ${relative.split(path.sep).join('/')}`);
  if (stale.length) inventory = await inventoryUnder(directory);
  const actual = inventory.files;
  const allowed = new Set(allowedPaths.map(value => value.toLowerCase()));
  for (const relative of actual) {
    const normalized = relative.split(path.sep).join('/');
    if (!allowed.has(normalized.toLowerCase())) throw new Error(`Unexpected file in restore staging directory: ${normalized}`);
  }
  const directories = inventory.directories.map(value => value.split(path.sep).join('/'));
  const allowedDirectorySet = new Set(allowedDirectories.map(value => value.toLowerCase()));
  for (const relative of directories) if (!allowedDirectorySet.has(relative.toLowerCase())) {
    throw new Error(`Unexpected directory in restore staging directory: ${relative}`);
  }
  return { files: actual.map(value => value.split(path.sep).join('/')), directories };
}

async function validateRestoredPathConfiguration(directory, manifest, destination, plan) {
  const systemFile = plan.files.find(file => file.path === 'config/system.xml');
  const identityFile = plan.files.find(file => file.path === 'data/data/device.txt');
  if (!systemFile || !identityFile) throw new Error('Restored Jellyfin identity controls are incomplete');
  const systemXml = (await readVerifiedRegularFile(directory, path.join(directory, 'config', 'system.xml'),
    controlFileLimits.systemConfiguration, 'Restored Jellyfin system configuration',
    { expectedBytes: systemFile.bytes, expectedSha256: systemFile.sha256 })).buffer.toString('utf8');
  if (XMLValidator.validate(systemXml) !== true) throw new Error('Restored Jellyfin system configuration is invalid XML');
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: false }).parse(systemXml)?.ServerConfiguration;
  const configuration = parsed === '' ? {} : parsed;
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Restored Jellyfin system configuration is invalid');
  }
  const serverId = decodeServerIdentity((await readVerifiedRegularFile(directory, path.join(directory, 'data', 'data', 'device.txt'), 1024,
    'Restored Jellyfin server identity', { expectedBytes: identityFile.bytes, expectedSha256: identityFile.sha256 })).buffer);
  if (serverId !== manifest.instanceState.identity.serverId) throw new Error('Restored Jellyfin server identity differs from the package');
  for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
    const binding = manifest.instanceState.pathBindings[name];
    const configured = configuration[field];
    if (binding.configured) {
      if (configured !== restoredBindingPath(manifest, destination, name)) throw new Error(`Restored Jellyfin ${field} does not point at the restored state root`);
    } else if (configured != null && (typeof configured !== 'string' || configured.trim())) {
      throw new Error(`Restored Jellyfin ${field} unexpectedly became configured`);
    }
  }
}

async function verifyRestoredTree(directory, manifest, destination, expectedStage, manifestSha256, plan,
  { requireCompleteInventory = true } = {}) {
  const state = await readOptionalJson(directory, restoredStatePath, controlFileLimits.restoredState, 'Restored state marker');
  validateRestoredState(state, manifest, destination, expectedStage, manifestSha256, plan);
  const expected = plan.files;
  const allowed = [...expected.map(file => file.path), restoredStatePath, restoredStateTemporaryPath];
  const allowedDirectories = manifest.directories.map(entry => entry.path);
  const actual = await assertRestoreInventory(directory, allowed, allowedDirectories);
  for (const file of expected) {
    const filename = path.join(directory, ...file.path.split('/'));
    await inspectRegularFile(directory, filename, `Restored asset ${file.path}`,
      { expectedBytes: file.bytes, expectedSha256: file.sha256 });
  }
  if (requireCompleteInventory) {
    const expectedPaths = new Set([...expected.map(file => file.path), restoredStatePath].map(value => value.toLowerCase()));
    const expectedDirectories = new Set(allowedDirectories.map(value => value.toLowerCase()));
    if (actual.files.length !== expectedPaths.size || actual.files.some(value => !expectedPaths.has(value.toLowerCase()))
      || actual.directories.length !== expectedDirectories.size || actual.directories.some(value => !expectedDirectories.has(value.toLowerCase()))) {
      throw new Error('Restored state inventory is incomplete');
    }
  }
  await validateRestoredPathConfiguration(directory, manifest, destination, plan);
  return state;
}

function validateMediaAccessStateAssets(mediaAccess, files) {
  const remoteFiles = validateRemoteAssetManifest(files);
  const byId = new Map(remoteFiles.map(file => [file.remote.assetId, file]));
  const linked = new Set();
  for (const item of mediaAccess.items) {
    for (const sidecar of item.sidecars) {
      if (sidecar.kind !== 'nfo' || sidecar.stateAssetId == null) continue;
      if (linked.has(sidecar.stateAssetId)) throw new Error(`NFO state asset is linked by more than one media access sidecar: ${sidecar.stateAssetId}`);
      linked.add(sidecar.stateAssetId);
      const file = byId.get(sidecar.stateAssetId);
      if (!file) throw new Error(`Declared NFO state asset is missing: ${sidecar.stateAssetId}`);
      if (file.remote.kind !== 'nfo') throw new Error(`Declared NFO state asset has the wrong kind: ${sidecar.stateAssetId}`);
      if (BigInt(file.bytes) !== BigInt(sidecar.expected.bytes) || file.sha256 !== sidecar.expected.sha256) {
        throw new Error(`Declared NFO state asset content differs from its media access expectation: ${sidecar.stateAssetId}`);
      }
    }
  }
}

function nativeEnvelopeIdentity(envelope) {
  return {
    fingerprint: envelope.fingerprint,
    ddlSha256: sha256Value(canonicalJson(envelope.ddl)),
    history: envelope.history.map(row => ({ MigrationId: row.MigrationId, ProductVersion: row.ProductVersion })),
    sqliteSequence: envelope.sqliteSequence.map(entry => ({ name: entry.name, seq: BigInt(entry.seq).toString() })),
  };
}

async function captureSourceIdentity(database, instanceState, remotePlan,
  { requirePinnedEnvelope = true, targetPortableMountContract = undefined, instanceStatePaths = null } = {}) {
  let databaseState;
  const capture = async current => {
    const postgresContract = current.dialect === 'postgres'
      ? await verifyPostgresTransferContract(current, {
        expectedServerId: instanceState.identity.serverId,
        requirePinnedEnvelope,
        requirePortableMountContract: true,
      })
      : null;
    const sourcePortableMountContract = postgresContract?.portableMountContract ?? null;
    const projectedPortableMountContract = targetPortableMountContract ?? sourcePortableMountContract;
    const projector = createSqliteExportPathProjector({
      sourceContract: sourcePortableMountContract,
      targetContract: projectedPortableMountContract,
      instanceStatePaths,
    });
    const tables = await databaseDigest(current);
    const projectedTables = await databaseDigest(current, { rowTransform: projector.projectRow });
    return {
      tables,
      projectedTables,
      pathProjection: projector.statistics(),
      instanceBinding: postgresContract?.instanceBinding ?? null,
      portableMountContract: sourcePortableMountContract,
      // The persisted envelope proves provenance, while PostgreSQL sequence
      // high-water is live source state and must be captured with the rows.
      nativeEnvelope: nativeEnvelopeIdentity(await getNativeEnvelope(current)),
      liveTvState: await captureLiveTvState(current),
    };
  };
  if (database.dialect === 'postgres') databaseState = await database.transaction(capture, { readOnly: true });
  else {
    if (database.database.isTransaction) throw new Error('State package source database must not already be in a transaction');
    database.database.exec('BEGIN');
    try { databaseState = await capture(database); database.database.exec('COMMIT'); }
    catch (error) { database.database.exec('ROLLBACK'); throw error; }
  }
  return {
    instanceIdentityDigest: instanceState.identity.digest,
    stateGeneration: instanceState.identity.stateGeneration,
    database: {
      dialect: database.dialect,
      schema: database.dialect === 'postgres' ? database.schemaName : null,
      instanceBinding: databaseState.instanceBinding,
      portableMountContract: databaseState.portableMountContract,
      nativeEnvelope: databaseState.nativeEnvelope,
      liveTvState: databaseState.liveTvState,
      tables: databaseState.tables,
      projectedTables: databaseState.projectedTables,
      pathProjection: databaseState.pathProjection,
    },
    remoteAssets: remotePlan?.assets ?? [],
  };
}

function captureRequestDigest({ sourceSha256, baseline, extensionState, mediaAccess, portableMountContract }) {
  return sha256Value(canonicalJson({ sourceSha256, baseline, extensionState, mediaAccess,
    portableMountContract }));
}

function projectMediaAccessPlan(plan, sourceContract, targetContract) {
  if (!sourceContract) return plan;
  const project = (value, label) => projectPortableJellyfinPath(value, sourceContract, targetContract, {
    label,
    requireMount: true,
  });
  return {
    ...plan,
    items: plan.items.map((item, itemIndex) => {
      const identityRoot = project(item.identityRoot, `mediaAccess.items[${itemIndex}].identityRoot`);
      return {
        ...item,
        identityPath: project(item.identityPath, `mediaAccess.items[${itemIndex}].identityPath`),
        identityRoot,
        enumeration: { ...item.enumeration, root: identityRoot },
        sidecars: item.sidecars.map((sidecar, sidecarIndex) => ({
          ...sidecar,
          identityPath: project(sidecar.identityPath,
            `mediaAccess.items[${itemIndex}].sidecars[${sidecarIndex}].identityPath`),
        })),
      };
    }),
  };
}

function validatePathProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'auditedPaths,rewrittenPaths'
    || !Number.isSafeInteger(value.auditedPaths) || value.auditedPaths < 0
    || !Number.isSafeInteger(value.rewrittenPaths) || value.rewrittenPaths < 0
    || value.rewrittenPaths > value.auditedPaths) {
    throw new Error('State package database path projection is invalid');
  }
  return value;
}

function validateManifestPortableMountContract(value) {
  if (value === null) return null;
  const canonical = canonicalPortableMountContract(value);
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    throw new Error('State package portable VFS mount contract is not canonical');
  }
  return canonical;
}

function validateNativeEnvelopeIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'ddlSha256,fingerprint,history,sqliteSequence'
    || !/^[a-f0-9]{64}$/u.test(value.fingerprint)
    || !/^[a-f0-9]{64}$/u.test(value.ddlSha256) || !Array.isArray(value.history) || !Array.isArray(value.sqliteSequence)) {
    throw new Error('State package source native database envelope is invalid');
  }
  for (const row of value.history) if (!row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).sort().join(',') !== 'MigrationId,ProductVersion'
    || typeof row.MigrationId !== 'string' || !row.MigrationId || typeof row.ProductVersion !== 'string' || !row.ProductVersion) {
    throw new Error('State package source native database envelope is invalid');
  }
  const names = new Set();
  for (const entry of value.sqliteSequence) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'name,seq'
      || typeof entry.name !== 'string' || !entry.name || names.has(entry.name) || !/^(?:0|[1-9]\d*)$/u.test(entry.seq)) {
      throw new Error('State package source native database envelope is invalid');
    }
    names.add(entry.name);
  }
  return value;
}

function validateCapturedSource(source, instanceState, manifest) {
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).sort().join(',') !== 'database,instanceIdentityDigest,remoteAssets,stateGeneration'
    || source.instanceIdentityDigest !== instanceState.identity.digest
    || canonicalJson(source.stateGeneration) !== canonicalJson(instanceState.identity.stateGeneration)
    || !source.database || typeof source.database !== 'object' || Array.isArray(source.database)
    || Object.keys(source.database).sort().join(',') !== 'dialect,instanceBinding,liveTvState,nativeEnvelope,pathProjection,portableMountContract,projectedTables,schema,tables'
    || !['sqlite', 'postgres'].includes(source.database.dialect)
    || (source.database.dialect === 'sqlite' && (source.database.schema !== null || source.database.instanceBinding !== null
      || source.database.portableMountContract !== null))
    || (source.database.dialect === 'postgres' && (typeof source.database.schema !== 'string' || !source.database.schema
      || source.database.portableMountContract === null))) {
    throw new Error('State package captured source identity is invalid');
  }
  const nativeEnvelope = validateNativeEnvelopeIdentity(source.database.nativeEnvelope);
  validateLiveTvState(source.database.liveTvState, manifest.instanceFiles, source.database.dialect);
  if (nativeEnvelope.fingerprint !== manifest.database.nativeSchemaFingerprint) {
    throw new Error('State package source native database envelope differs from its exported database');
  }
  let sourcePortableMountContract = null;
  if (source.database.dialect === 'postgres') {
    const binding = source.database.instanceBinding;
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).sort().join(',') !== 'originIdentityDigest,serverId'
      || binding.serverId !== instanceState.identity.serverId
      || typeof binding.originIdentityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(binding.originIdentityDigest)) {
      throw new Error('State package PostgreSQL source binding is invalid');
    }
    sourcePortableMountContract = validateManifestPortableMountContract(source.database.portableMountContract);
  }
  const projection = validatePathProjection(manifest.database.pathProjection);
  const packagedPortableMountContract = validateManifestPortableMountContract(manifest.database.portableMountContract);
  if (source.database.dialect === 'sqlite' && packagedPortableMountContract !== null) {
    throw new Error('A SQLite state package cannot declare a portable VFS mount retarget');
  }
  if (sourcePortableMountContract) {
    try { assertPortableMountRetarget(sourcePortableMountContract, packagedPortableMountContract); }
    catch (cause) {
      throw new Error('State package target portable VFS mount contract is incompatible with its source', { cause });
    }
  }
  const sourceProjection = validatePathProjection(source.database.pathProjection);
  if (!Array.isArray(source.database.tables) || !Array.isArray(source.database.projectedTables)
    || canonicalJson(source.database.projectedTables) !== canonicalJson(manifest.database.tables)
    || canonicalJson(sourceProjection) !== canonicalJson(projection)) {
    throw new Error('State package source database generation differs from its exported database');
  }
  if (!Array.isArray(source.remoteAssets) || source.remoteAssets.length !== manifest.remoteAssets.length) {
    throw new Error('State package remote source identity is invalid');
  }
  const byId = new Map(manifest.remoteAssets.map(file => [file.remote.assetId, file]));
  const sourceIds = new Set();
  for (const asset of source.remoteAssets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
      || Object.keys(asset).sort().join(',') !== 'assetId,kind,modifiedAt,restorePath,sha256,size,version,virtualPath'
      || !/^[a-f0-9]{64}$/u.test(asset.sha256)) {
      throw new Error('State package remote source identity is invalid');
    }
    if (sourceIds.has(asset.assetId)) throw new Error('State package remote source identity contains a duplicate asset');
    sourceIds.add(asset.assetId);
    const file = byId.get(asset.assetId);
    if (!file || file.path !== `remote-assets/${asset.restorePath}` || file.remote.virtualPath !== asset.virtualPath
      || file.remote.kind !== asset.kind || file.remote.version !== asset.version
      || !/^(?:0|[1-9]\d*)$/u.test(asset.size) || BigInt(asset.size) !== BigInt(file.bytes)
      || asset.sha256 !== file.sha256
      || asset.modifiedAt !== file.modifiedAt) throw new Error('State package remote source identity differs from its captured assets');
  }
  if ([...byId.keys()].some(assetId => !sourceIds.has(assetId))) throw new Error('State package remote source identity is incomplete');
}

/** A caller must discover the complete instance and establish a bound write barrier before packaging files. */
export async function createStatePackage(options) {
  const allowedOptions = ['database', 'destination', 'instanceState', 'baseline', 'captureSession', 'extensionState', 'mediaAccess', 'remoteState', 'signal', 'testOnlyAllowSyntheticEnvelope', 'targetPortableMountContract'];
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => !allowedOptions.includes(key))) throw new TypeError('Invalid state package creation options');
  if (typeof options.destination !== 'string' || !options.destination) throw new TypeError('State package destination is required');
  // Capture the routing fields before the first await so caller mutation cannot
  // separate the operation lease from the destination actually written.
  const capturedOptions = { ...options, destination: path.resolve(options.destination) };
  const destination = await prospectivePhysicalPath(capturedOptions.destination, 'State package destination');
  return withOperationLease(pathIdentity(destination), 'State package capture', lease => createStatePackageOwned(capturedOptions, lease));
}

async function createStatePackageOwned(options, lease) {
  lease.assertHeld();
  let { database, destination, instanceState, baseline, captureSession,
    extensionState = {}, mediaAccess = { scope: 'explicit-items', items: [] }, remoteState, signal,
    testOnlyAllowSyntheticEnvelope = false, targetPortableMountContract } = options;
  if (typeof testOnlyAllowSyntheticEnvelope !== 'boolean') throw new TypeError('testOnlyAllowSyntheticEnvelope must be a boolean');
  instanceState = validateInstanceStateSnapshot(instanceState);
  const writeBarrier = await assertCaptureSessionHeld(captureSession, instanceState, 'pre');
  await validateWriteBarrier(writeBarrier, instanceState);
  const { roots } = instanceState;
  const sourceDatabasePaths = [instanceState.paths.sqlite];
  const databaseRestorePath = expectedDatabaseRestorePath(instanceState);
  if (!baseline) throw new Error('Baseline identity is required');
  baseline = structuredClone(baseline);
  extensionState = structuredClone(extensionState);
  if (!extensionState || typeof extensionState !== 'object' || Array.isArray(extensionState)) {
    throw new TypeError('Extension state must be a plain object');
  }
  if (new Set(Object.keys(roots).map(label => label.toLowerCase())).size !== Object.keys(roots).length) throw new Error('State root labels must be distinct under destination path comparison');
  for (const label of Object.keys(roots)) if (!/^[A-Za-z0-9_-]+$/.test(label) || label.toLowerCase() === 'remote-assets') throw new Error('Invalid or reserved state root label');
  if (!database || !['sqlite', 'postgres'].includes(database.dialect)) throw new Error('A supported package database is required');
  if (database.dialect === 'sqlite' && pathIdentity(database.filename) !== pathIdentity(instanceState.paths.sqlite)) {
    throw new Error('SQLite package database must be the discovered instance database');
  }
  await database.preflight();
  let sourcePortableMountContract = null;
  if (database.dialect === 'postgres') {
    const postgresContract = await verifyPostgresTransferContract(database, {
      expectedServerId: instanceState.identity.serverId,
      requirePinnedEnvelope: !testOnlyAllowSyntheticEnvelope,
      requirePortableMountContract: true,
    });
    sourcePortableMountContract = postgresContract.portableMountContract;
  }
  if (targetPortableMountContract !== undefined) {
    if (!sourcePortableMountContract) {
      throw new Error('A target portable VFS mount contract requires a PostgreSQL package database');
    }
    targetPortableMountContract = assertPortableMountRetarget(sourcePortableMountContract,
      canonicalPortableMountContract(targetPortableMountContract));
  }
  const exportPortableMountContract = targetPortableMountContract ?? sourcePortableMountContract;
  validateDatabaseRestorePath(databaseRestorePath);
  const sourceMediaAccess = structuredClone(mediaAccess);
  await validateMediaAccessPlan(sourceMediaAccess, database);
  mediaAccess = projectMediaAccessPlan(sourceMediaAccess, sourcePortableMountContract, exportPortableMountContract);
  const remotePlan = remoteState ? await inspectRemoteAssets({ ...remoteState, signal }) : undefined;
  const sourceIdentity = await captureSourceIdentity(database, instanceState, remotePlan, {
    requirePinnedEnvelope: !testOnlyAllowSyntheticEnvelope,
    targetPortableMountContract: exportPortableMountContract,
    instanceStatePaths: { programData: instanceState.paths.programData, metadata: instanceState.paths.metadata },
  });
  if (canonicalJson(sourceIdentity.database.portableMountContract) !== canonicalJson(sourcePortableMountContract)) {
    throw new Error('PostgreSQL portable VFS mount contract changed during state package preflight');
  }
  const sourceSha256 = sha256Value(canonicalJson(sourceIdentity));
  const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const databaseFiles = new Set([...sourceDatabasePaths, ...(database.dialect === 'sqlite' ? [database.filename] : [])]
    .flatMap(filename => [filename, `${filename}-wal`, `${filename}-shm`]).map(pathKey));
  destination = await prospectivePhysicalPath(path.resolve(destination), 'State package destination');
  let staging = packageStagingPath(destination);
  const physicalDestination = destination;
  const physicalStaging = await prospectivePhysicalPath(staging, 'State package capture staging path');
  staging = physicalStaging;
  for (const source of Object.values(roots)) if (inside(path.resolve(source), physicalDestination) || inside(physicalDestination, path.resolve(source))
    || inside(path.resolve(source), physicalStaging) || inside(physicalStaging, path.resolve(source))) throw new Error('State package source and destination must not overlap');
  const requestSha256 = captureRequestDigest({ sourceSha256, baseline, extensionState, mediaAccess,
    portableMountContract: exportPortableMountContract });
  const expectedProgress = { destination, requestSha256, sourceSha256 };
  let destinationMetadata;
  try { destinationMetadata = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationMetadata) {
    if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) throw new Error('State package destination already exists and is not a complete package directory');
    const existing = await verifyStatePackage(destination);
    if (existing.captureRequestSha256 !== requestSha256 || canonicalJson(existing.source) !== canonicalJson(sourceIdentity)) {
      throw new Error('Existing state package was created from a different request or source generation');
    }
    if (remoteState) await verifyRemoteGeneration(remoteState.vfs, existing.remoteAssets, signal);
    const finalWriteBarrier = await assertCaptureSessionHeld(captureSession, instanceState, 'post');
    if (JSON.stringify(finalWriteBarrier) !== JSON.stringify(writeBarrier)) throw new Error('Capture session evidence changed during state packaging');
    await validateWriteBarrier(writeBarrier, instanceState);
    lease.assertHeld();
    return existing;
  }

  let stagingMetadata, progress;
  try { stagingMetadata = await lstat(staging); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stagingMetadata) {
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) throw new Error('State package capture staging path is not a directory');
    lease.assertHeld();
    await validateCaptureControlInventory(staging);
    const persistedProgress = await readOptionalJson(staging, 'progress.json', controlFileLimits.progress, 'State package capture progress');
    if (persistedProgress === undefined) {
      const entries = new Set((await readdir(staging)).map(entry => entry));
      if ([...entries].some(entry => !['files', 'progress.json.tmp'].includes(entry))) {
        throw new Error('State package capture staging is missing its progress record');
      }
      if (entries.has('files')) {
        const inventory = await inventoryUnder(path.join(staging, 'files'));
        if (inventory.files.length || inventory.directories.length) throw new Error('State package capture staging is missing its progress record');
      } else await mkdir(path.join(staging, 'files'));
      const startedAt = new Date().toISOString();
      progress = { kind: 'state-package-capture', generation: randomUUID(), destination,
        requestSha256, sourceSha256, stage: 'preflight', startedAt, updatedAt: startedAt, lastError: null };
      lease.assertHeld();
      await journal(staging, progress);
    } else {
      progress = validateCaptureProgress(persistedProgress, expectedProgress);
      destination = progress.destination;
    }
    try {
      await lstat(path.join(staging, 'COMMITTED'));
      const committed = await verifyStatePackage(staging);
      if (committed.captureRequestSha256 !== requestSha256 || canonicalJson(committed.source) !== canonicalJson(sourceIdentity)) {
        throw new Error('Committed state package staging was created from a different request or source generation');
      }
      if (remoteState) await verifyRemoteGeneration(remoteState.vfs, committed.remoteAssets, signal);
      const finalWriteBarrier = await assertCaptureSessionHeld(captureSession, instanceState, 'post');
      if (JSON.stringify(finalWriteBarrier) !== JSON.stringify(writeBarrier)) throw new Error('Capture session evidence changed during state packaging');
      await validateWriteBarrier(writeBarrier, instanceState);
      signal?.throwIfAborted();
      lease.assertHeld();
      await rename(staging, destination);
      return committed;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    lease.assertHeld();
    await mkdir(staging, { recursive: false });
    await mkdir(path.join(staging, 'files'));
    const startedAt = new Date().toISOString();
    progress = { kind: 'state-package-capture', generation: randomUUID(), destination,
      requestSha256, sourceSha256, stage: 'preflight', startedAt, updatedAt: startedAt, lastError: null };
    lease.assertHeld();
    await journal(staging, progress);
  }
  try {
    signal?.throwIfAborted();
    const manifest = { generation: progress.generation, captureRequestSha256: requestSha256,
      source: sourceIdentity, baseline, instanceState, writeBarrier, extensionState, mediaAccess, directories: [], instanceFiles: [],
      remoteAssets: [], excludedDatabaseFiles: [], database: null };
    const fileInventory = [];
    const directoryInventory = [];
    for (const [label, source] of Object.entries(roots)) {
      const resolved = path.resolve(source);
      if ((await lstat(resolved)).isSymbolicLink()) throw new Error('State root must not be a symbolic link');
      const sourceInventory = await inventoryUnder(resolved);
      for (const relative of ['', ...sourceInventory.directories]) {
        const original = path.join(resolved, relative), metadata = await lstat(original, { bigint: true });
        const destinationRelative = [label, relative.split(path.sep).join('/')].filter(Boolean).join('/');
        const modifiedAt = dateFromNanoseconds(metadata.mtimeNs).toISOString();
        manifest.directories.push({ path: destinationRelative, modifiedAt });
        directoryInventory.push({ original, path: destinationRelative, modifiedAt });
      }
      for (const relative of sourceInventory.files) {
        signal?.throwIfAborted();
        const original = path.join(resolved, relative);
        if (databaseFiles.has(pathKey(original))) { manifest.excludedDatabaseFiles.push(`${label}/${relative.split(path.sep).join('/')}`); continue; }
        const destinationRelative = `${label}/${relative.split(path.sep).join('/')}`;
        const inspected = await inspectRegularFile(resolved, original, `State package source ${destinationRelative}`);
        const metadata = inspected.metadata;
        if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`State file is too large to package safely: ${destinationRelative}`);
        manifest.instanceFiles.push({ path: destinationRelative, bytes: Number(metadata.size), sha256: inspected.sha256,
          modifiedAt: dateFromNanoseconds(metadata.mtimeNs).toISOString() });
        fileInventory.push({ sourceRoot: resolved, original, path: destinationRelative, hash: inspected.sha256, bytes: Number(metadata.size),
          atime: dateFromNanoseconds(metadata.atimeNs), mtime: dateFromNanoseconds(metadata.mtimeNs) });
      }
    }
    validateLiveTvState(sourceIdentity.database.liveTvState, manifest.instanceFiles, database.dialect);
    manifest.directories.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const plannedRemotePaths = remotePlan?.assets.map(asset => `remote-assets/${asset.restorePath}`) ?? [];
    const allowedCaptureDirectories = new Set(manifest.directories.map(entry => entry.path));
    for (const value of plannedRemotePaths) for (const parent of relativeParents(value)) allowedCaptureDirectories.add(parent);
    const capturedFilesRoot = path.join(staging, 'files');
    lease.assertHeld();
    await assertRestoreInventory(capturedFilesRoot, [...manifest.instanceFiles.map(file => file.path), ...plannedRemotePaths],
      [...allowedCaptureDirectories], { atomicTargets: [...manifest.instanceFiles.map(file => file.path), ...plannedRemotePaths] });
    for (const directory of [...manifest.directories].sort((left, right) => left.path.split('/').length - right.path.split('/').length)) {
      await ensurePhysicalDirectory(capturedFilesRoot, path.join(capturedFilesRoot, ...directory.path.split('/')),
        `State package capture directory ${directory.path}`);
    }
    for (const file of fileInventory) {
      signal?.throwIfAborted();
      lease.assertHeld();
      const output = path.join(capturedFilesRoot, ...file.path.split('/'));
      await assertPhysicalDirectory(capturedFilesRoot, path.dirname(output), `State package capture asset ${file.path}`);
      let outputMetadata, reused = false;
      try { outputMetadata = await lstat(output); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (outputMetadata) {
        if (!outputMetadata.isFile() || outputMetadata.isSymbolicLink()) throw new Error(`State package capture target is not a regular file: ${file.path}`);
        try {
          await inspectRegularFile(capturedFilesRoot, output, `State package capture target ${file.path}`,
            { expectedBytes: file.bytes, expectedSha256: file.hash });
          reused = true;
        } catch (error) {
          if (!/checksum mismatch/u.test(error.message)) throw error;
        }
      }
      if (!reused) await atomicCopyVerified(file.sourceRoot, file.original, capturedFilesRoot, output,
        `State package capture asset ${file.path}`, { expectedBytes: file.bytes, expectedSha256: file.hash,
          accessedAt: file.atime, modifiedAt: file.mtime });
      await inspectRegularFile(capturedFilesRoot, output, `Captured state asset ${file.path}`,
        { expectedBytes: file.bytes, expectedSha256: file.hash });
    }
    lease.assertHeld();
    manifest.remoteAssets = remotePlan ? await captureRemoteAssets({ plan: remotePlan, destination: staging, signal }) : [];
    validateMediaAccessStateAssets(mediaAccess, manifest.remoteAssets);
    const allFiles = [...manifest.instanceFiles, ...manifest.remoteAssets];
    if (new Set(allFiles.map(file => file.path.toLowerCase())).size !== allFiles.length) throw new Error('State files collide under destination path comparison');
    validateFileManifest(manifest.instanceFiles, { remote: false });
    validateFileManifest(manifest.remoteAssets, { remote: true });
    const assetPaths = manifest.instanceFiles.map(file => file.path);
    validateAssetRestorePaths(assetPaths);
    validateDatabaseRestorePath(databaseRestorePath, assetPaths);
    validateDirectoryManifest(manifest.directories, manifest.instanceFiles, databaseRestorePath);
    validateExcludedDatabaseFiles(manifest.excludedDatabaseFiles, instanceState);
    validatePackagedStateGeneration(manifest, instanceState);
    progress.stage = 'files-captured'; progress.updatedAt = new Date().toISOString(); progress.lastError = null;
    lease.assertHeld(); await journal(staging, progress);
    const temporaryDatabase = path.join(staging, 'jellyfin.db.tmp'), packagedDatabase = path.join(staging, 'jellyfin.db');
    lease.assertHeld();
    await removeOptionalRegularFile(temporaryDatabase);
    const migration = await exportCurrentSqlite(database, temporaryDatabase, {
      signal,
      testOnlyAllowSyntheticEnvelope,
      instanceStatePaths: { programData: instanceState.paths.programData, metadata: instanceState.paths.metadata },
      ...(targetPortableMountContract ? { targetPortableMountContract } : {}),
    });
    const snapshot = new SqliteDatabase(temporaryDatabase, { readOnly: true });
    try { await validateMediaAccessPlan(mediaAccess, snapshot); } finally { snapshot.close(); }
    if (canonicalJson(migration.tables) !== canonicalJson(sourceIdentity.database.projectedTables)
      || canonicalJson(migration.pathProjection) !== canonicalJson(sourceIdentity.database.pathProjection)) {
      throw new Error('Packaged database differs from the captured source database generation');
    }
    if (canonicalJson(migration.portableMountContract) !== canonicalJson(exportPortableMountContract)) {
      throw new Error('Packaged database portable VFS mount contract differs from the requested target');
    }
    if (migration.nativeSchemaFingerprint !== sourceIdentity.database.nativeEnvelope.fingerprint
      || canonicalJson(migration.migrationHistory) !== canonicalJson(sourceIdentity.database.nativeEnvelope.history)
      || canonicalJson(migration.sqliteSequence.map(entry => ({ name: entry.name, seq: BigInt(entry.seq).toString() })))
        !== canonicalJson(sourceIdentity.database.nativeEnvelope.sqliteSequence)) {
      throw new Error('Packaged database native envelope differs from the captured source database generation');
    }
    const packagedDatabaseSha256 = (await inspectRegularFile(staging, temporaryDatabase,
      'State package captured database')).sha256;
    lease.assertHeld();
    await removeOptionalRegularFile(packagedDatabase);
    await rename(temporaryDatabase, packagedDatabase);
    manifest.database = { path: 'jellyfin.db', restorePath: databaseRestorePath, sha256: packagedDatabaseSha256,
      tables: migration.tables, nativeSchemaFingerprint: migration.nativeSchemaFingerprint,
      pathProjection: migration.pathProjection, portableMountContract: migration.portableMountContract };
    progress.stage = 'database-captured'; progress.updatedAt = new Date().toISOString();
    lease.assertHeld(); await journal(staging, progress);
    for (const file of fileInventory) {
      try {
        await inspectRegularFile(file.sourceRoot, file.original, `State package source ${file.path}`,
          { expectedBytes: file.bytes, expectedSha256: file.hash });
      } catch (cause) { throw new Error(`State file changed during database capture: ${file.path}`, { cause }); }
    }
    for (const directory of directoryInventory) if (dateFromNanoseconds((await lstat(directory.original, { bigint: true })).mtimeNs).toISOString() !== directory.modifiedAt) {
      throw new Error(`State directory changed during database capture: ${directory.path}`);
    }
    // Detect additions/deletions after the initial copy, including unknown plugin assets.
    for (const [label, source] of Object.entries(roots)) {
      const currentInventory = await inventoryUnder(source);
      const current = currentInventory.files.map(relative => path.resolve(source, relative)).filter(filename => !databaseFiles.has(pathKey(filename)));
      const captured = fileInventory.filter((entry) => inside(path.resolve(source), entry.original)).map((entry) => path.resolve(entry.original));
      if (JSON.stringify(current.sort()) !== JSON.stringify(captured.sort())) throw new Error(`State file inventory changed: ${label}`);
      const currentDirectories = ['', ...currentInventory.directories].map(relative => [label, relative.split(path.sep).join('/')].filter(Boolean).join('/')).sort();
      const capturedDirectories = directoryInventory.filter(entry => inside(path.resolve(source), entry.original)).map(entry => entry.path).sort();
      if (JSON.stringify(currentDirectories) !== JSON.stringify(capturedDirectories)) throw new Error(`State directory inventory changed: ${label}`);
    }
    if (remoteState) await verifyRemoteGeneration(remoteState.vfs, manifest.remoteAssets, signal);
    const finalSourceIdentity = await captureSourceIdentity(database, instanceState, remotePlan, {
      requirePinnedEnvelope: !testOnlyAllowSyntheticEnvelope,
      targetPortableMountContract: exportPortableMountContract,
      instanceStatePaths: { programData: instanceState.paths.programData, metadata: instanceState.paths.metadata },
    });
    if (canonicalJson(finalSourceIdentity) !== canonicalJson(sourceIdentity)) throw new Error('Package source database or remote generation changed during capture');
    const finalWriteBarrier = await assertCaptureSessionHeld(captureSession, instanceState, 'post');
    if (JSON.stringify(finalWriteBarrier) !== JSON.stringify(writeBarrier)) throw new Error('Capture session evidence changed during state packaging');
    await validateWriteBarrier(writeBarrier, instanceState);
    const manifestFilename = path.join(staging, 'manifest.json');
    lease.assertHeld();
    await writeJsonAtomic(staging, 'manifest.json', manifestTemporaryPath, manifest);
    progress.stage = 'verified'; progress.updatedAt = new Date().toISOString(); progress.lastError = null;
    lease.assertHeld(); await journal(staging, progress);
    const commit = { generation: progress.generation,
      manifestSha256: (await readRegularFileBounded(staging, manifestFilename, controlFileLimits.manifest, 'State package manifest')).sha256 };
    lease.assertHeld(); await writeJsonAtomic(staging, 'COMMITTED', committedTemporaryPath, commit);
    const verified = await verifyStatePackage(staging);
    signal?.throwIfAborted();
    lease.assertHeld();
    await rename(staging, destination);
    return verified;
  } catch (thrown) {
    const error = normalizeThrown(thrown, 'State package capture failed');
    progress.updatedAt = new Date().toISOString(); progress.lastError = error.message;
    try { lease.assertHeld(); await journal(staging, progress); } catch {}
    throw error;
  }
}

async function verifyStatePackageDetailed(directory) {
  directory = path.resolve(directory);
  await assertPhysicalDirectory(directory, directory, 'State package');
  await validatePackageControlInventory(directory);
  const manifestFilename = path.join(directory, 'manifest.json');
  const manifestControl = await readJsonBounded(directory, manifestFilename, controlFileLimits.manifest, 'State package manifest');
  const commitControl = await readJsonBounded(directory, path.join(directory, 'COMMITTED'), controlFileLimits.commit, 'State package commit');
  const manifest = manifestControl.value, commit = commitControl.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !commit || typeof commit !== 'object' || Array.isArray(commit)
    || Object.keys(commit).sort().join(',') !== 'generation,manifestSha256'
    || commit.generation !== manifest.generation || commit.manifestSha256 !== manifestControl.sha256) {
    throw new Error('State package is incomplete, modified, or has an unknown format');
  }
  const manifestKeys = ['baseline', 'captureRequestSha256', 'database', 'directories', 'excludedDatabaseFiles', 'extensionState',
    'generation', 'instanceFiles', 'instanceState', 'mediaAccess', 'remoteAssets', 'source', 'writeBarrier'];
  if (Object.keys(manifest).sort().join(',') !== manifestKeys.sort().join(',')
    || typeof manifest.generation !== 'string' || !/^[a-f0-9-]{36}$/iu.test(manifest.generation)
    || typeof manifest.captureRequestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(manifest.captureRequestSha256)
    || !manifest.database || Object.keys(manifest.database).sort().join(',') !== 'nativeSchemaFingerprint,path,pathProjection,portableMountContract,restorePath,sha256,tables'
    || !/^[a-f0-9]{64}$/u.test(manifest.database.nativeSchemaFingerprint)) {
    throw new Error('State package manifest has an invalid schema');
  }
  const instanceState = validateInstanceStateSnapshot(manifest.instanceState);
  if (manifest.database.restorePath !== expectedDatabaseRestorePath(instanceState)) {
    throw new Error('State package database restore path differs from the discovered native database path');
  }
  if (!manifest.extensionState || typeof manifest.extensionState !== 'object' || Array.isArray(manifest.extensionState)) {
    throw new Error('State package extension state is invalid');
  }
  validateWriteBarrierSnapshot(manifest.writeBarrier, instanceState);
  validatePathProjection(manifest.database.pathProjection);
  validateManifestPortableMountContract(manifest.database.portableMountContract);
  validateExcludedDatabaseFiles(manifest.excludedDatabaseFiles, instanceState);
  const progress = (await readJsonBounded(directory, path.join(directory, 'progress.json'), controlFileLimits.progress,
    'State package capture progress')).value;
  const sourceSha256 = sha256Value(canonicalJson(manifest.source));
  validateCaptureProgress(progress, { destination: progress.destination, requestSha256: manifest.captureRequestSha256, sourceSha256 });
  if (progress.stage !== 'verified' || progress.generation !== manifest.generation) {
    throw new Error('State package generation does not match its commit or capture request');
  }
  validateFileManifest(manifest.instanceFiles, { remote: false });
  validateFileManifest(manifest.remoteAssets, { remote: true });
  validateRemoteAssetManifest(manifest.remoteAssets);
  validateAssetRestorePaths(manifest.instanceFiles.map(file => file.path));
  validateDatabaseRestorePath(manifest.database.restorePath, manifest.instanceFiles.map(file => file.path));
  validateDirectoryManifest(manifest.directories, manifest.instanceFiles, manifest.database.restorePath);
  validatePackagedStateGeneration(manifest, instanceState);
  validateCapturedSource(manifest.source, instanceState, manifest);
  const actual = await inventoryUnder(path.join(directory, 'files'));
  const actualFiles = actual.files.map(value => value.split(path.sep).join('/'));
  const actualDirectories = actual.directories.map(value => value.split(path.sep).join('/'));
  const allFiles = [...manifest.instanceFiles, ...manifest.remoteAssets];
  if (actualFiles.length !== allFiles.length) throw new Error('Unlisted files in state package');
  const expectedDirectories = new Set(manifest.directories.map(entry => entry.path.toLowerCase()));
  for (const file of allFiles) for (const parent of relativeParents(file.path)) expectedDirectories.add(parent.toLowerCase());
  if (actualDirectories.length !== expectedDirectories.size || actualDirectories.some(value => !expectedDirectories.has(value.toLowerCase()))) {
    throw new Error('Unlisted directories in state package');
  }
  const seen = new Set();
  for (const file of allFiles) {
    if (!safeRelative(file.path) || seen.has(file.path.toLowerCase())) throw new Error('Invalid or duplicate package path');
    seen.add(file.path.toLowerCase());
    const filename = path.join(directory, 'files', file.path);
    await inspectRegularFile(directory, filename, `State asset ${file.path}`,
      { expectedBytes: file.bytes, expectedSha256: file.sha256 });
  }
  await validatePackagedPathBindings(directory, instanceState,
    manifest.instanceFiles.find(file => file.path === 'config/system.xml'));
  validateAssetRestorePaths([...seen]);
  validateDatabaseRestorePath(manifest.database.restorePath, [...seen]);
  validateMediaAccessStateAssets(manifest.mediaAccess, manifest.remoteAssets);
  if (captureRequestDigest({ sourceSha256, baseline: manifest.baseline,
    extensionState: manifest.extensionState, mediaAccess: manifest.mediaAccess,
    portableMountContract: manifest.database.portableMountContract }) !== manifest.captureRequestSha256) {
    throw new Error('State package capture request digest does not match its manifest');
  }
  if (manifest.database.path !== 'jellyfin.db') throw new Error('Database package checksum mismatch');
  const temporaryDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'mediamanager-state-verify-')));
  const temporaryDatabase = path.join(temporaryDirectory, 'jellyfin.db');
  let database;
  try {
    await atomicCopyVerified(directory, path.join(directory, 'jellyfin.db'), temporaryDirectory, temporaryDatabase,
      'Database package verification', { expectedSha256: manifest.database.sha256 });
    database = new SqliteDatabase(temporaryDatabase, { readOnly: true });
    const pathProjector = createSqliteExportPathProjector({
      sourceContract: manifest.database.portableMountContract,
      targetContract: manifest.database.portableMountContract,
    });
    if (JSON.stringify(await databaseDigest(database, { rowTransform: pathProjector.projectRow }))
      !== JSON.stringify(manifest.database.tables)) throw new Error('Database content digest mismatch');
    if (pathProjector.statistics().auditedPaths !== manifest.database.pathProjection.auditedPaths) {
      throw new Error('Database portable path audit differs from its manifest');
    }
    if (canonicalJson(nativeEnvelopeIdentity(await getNativeEnvelope(database))) !== canonicalJson(manifest.source.database.nativeEnvelope)) {
      throw new Error('Database native envelope mismatch');
    }
    await validateMediaAccessPlan(manifest.mediaAccess, database);
  }
  finally {
    database?.close();
    try { await unlink(temporaryDatabase); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rmdir(temporaryDirectory);
  }
  return { manifest, manifestSha256: manifestControl.sha256 };
}

export async function verifyStatePackage(directory) {
  return (await verifyStatePackageDetailed(directory)).manifest;
}

export async function restoreStatePackage(directory, destination, options = {}) {
  if (typeof destination !== 'string' || !destination) throw new TypeError('Restore destination is required');
  const physicalDestination = await prospectivePhysicalPath(path.resolve(destination), 'Restore destination');
  return withOperationLease(pathIdentity(physicalDestination), 'State package restore',
    lease => restoreStatePackageOwned(directory, destination, options, lease));
}

async function restoreStatePackageOwned(directory, destination, { signal, onProgress } = {}, lease) {
  lease.assertHeld();
  if (onProgress != null && typeof onProgress !== 'function') throw new TypeError('Restore progress callback must be a function');
  directory = path.resolve(directory);
  const { manifest, manifestSha256 } = await verifyStatePackageDetailed(directory);
  const physicalPackage = await realpath(directory);
  destination = await prospectivePhysicalPath(path.resolve(destination), 'Restore destination');
  let staging = restoreStagingPath(destination, manifest.generation);
  const physicalStaging = await prospectivePhysicalPath(staging, 'Restore staging path');
  staging = physicalStaging;
  const suffix = `.mediamanager-restore-${manifest.generation}`;
  const stagingName = path.basename(staging);
  if (stagingName.startsWith('.') && stagingName.toLowerCase().endsWith(suffix.toLowerCase())) {
    const resumedName = stagingName.slice(1, -suffix.length);
    const resumedDestination = path.join(path.dirname(staging), resumedName);
    if (pathIdentity(resumedDestination) === pathIdentity(destination)) destination = resumedDestination;
  }
  const physicalDestination = destination;
  if (inside(physicalPackage, physicalDestination) || inside(physicalDestination, physicalPackage)) throw new Error('Restore destination overlaps package');
  const plan = await createRestorePlan(directory, manifest, destination);
  if (inside(physicalPackage, physicalStaging) || inside(physicalStaging, physicalPackage)) throw new Error('Restore staging directory overlaps package');
  let destinationMetadata;
  try { destinationMetadata = await lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (destinationMetadata) {
    if (!destinationMetadata.isDirectory() || destinationMetadata.isSymbolicLink()) throw new Error('Restore destination already exists and is not a restored directory');
    await verifyRestoredTree(destination, manifest, destination, 'complete', manifestSha256, plan);
    lease.assertHeld();
    return { destination, manifest, mediaAccessVerified: false, resumed: true, alreadyRestored: true, reusedFiles: plan.files.length };
  }
  let stagingMetadata, resumed = false;
  try { stagingMetadata = await lstat(staging); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stagingMetadata) {
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) throw new Error('Restore staging path is not a directory');
    resumed = true;
  } else { lease.assertHeld(); await mkdir(staging, { recursive: false }); }

  const expectedFiles = plan.files;
  const allowedPaths = [...expectedFiles.map(file => file.path), restoredStatePath, restoredStateTemporaryPath];
  const allowedDirectories = manifest.directories.map(entry => entry.path);
  lease.assertHeld();
  await assertRestoreInventory(staging, allowedPaths, allowedDirectories,
    { atomicTargets: [...expectedFiles.map(file => file.path), restoredStatePath] });
  let state = await readOptionalJson(staging, restoredStatePath, controlFileLimits.restoredState, 'Restore staging state');
  if (state) validateRestoredState(state, manifest, destination, state.stage, manifestSha256, plan);
  else {
    state = restoredState(manifest, destination, 'restoring', manifestSha256, plan);
    lease.assertHeld();
    await writeJsonAtomic(staging, restoredStatePath, restoredStateTemporaryPath, state);
  }
  if (!['restoring', 'complete'].includes(state.stage)) throw new Error('Restore staging state has an unknown stage');
  if (state.stage === 'complete') {
    await verifyRestoredTree(staging, manifest, destination, 'complete', manifestSha256, plan);
    if (pathIdentity(await prospectivePhysicalPath(destination, 'Restore destination')) !== pathIdentity(destination)) {
      throw new Error('Restore destination parent changed before publication');
    }
    lease.assertHeld();
    await rename(staging, destination);
    return { destination, manifest, mediaAccessVerified: false, resumed: true, alreadyRestored: false, reusedFiles: expectedFiles.length };
  }

  for (const directory of [...manifest.directories].sort((left, right) => left.path.split('/').length - right.path.split('/').length)) {
    await ensurePhysicalDirectory(staging, path.join(staging, ...directory.path.split('/')), `Restore directory ${directory.path}`);
  }

  let completed = 0, reusedFiles = 0;
  for (const file of expectedFiles) {
    signal?.throwIfAborted();
    lease.assertHeld();
    const filename = path.join(staging, ...file.path.split('/'));
    await assertPhysicalDirectory(staging, path.dirname(filename), `Restore asset ${file.path}`);
    let reused = false, metadata;
    try { metadata = await lstat(filename); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata) {
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Restore target is not a regular file: ${file.path}`);
      try {
        await inspectRegularFile(staging, filename, `Restore target ${file.path}`,
          { expectedBytes: file.bytes, expectedSha256: file.sha256 });
        reused = true;
      } catch (error) {
        if (!/checksum mismatch/u.test(error.message)) throw error;
      }
    }
    if (!reused) {
      const modifiedAt = file.modifiedAt ? new Date(file.modifiedAt) : undefined;
      if (file.content) await atomicWriteBuffer(staging, filename, file.content, `Restore asset ${file.path}`, { modifiedAt });
      else await atomicCopyVerified(directory, path.join(directory, ...file.source), staging, filename,
        `Restore asset ${file.path}`, { expectedBytes: file.bytes, expectedSha256: file.sha256, modifiedAt });
      await inspectRegularFile(staging, filename, `Restored asset ${file.path}`,
        { expectedBytes: file.bytes, expectedSha256: file.sha256 });
    } else reusedFiles++;
    completed++;
    await onProgress?.({ path: file.path, completed, total: expectedFiles.length, reused });
  }
  signal?.throwIfAborted();
  for (const directory of [...manifest.directories].sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
    if (directory.modifiedAt) {
      lease.assertHeld();
      const modified = new Date(directory.modifiedAt);
      const restoredDirectory = path.join(staging, ...directory.path.split('/'));
      await assertPhysicalDirectory(staging, restoredDirectory, `Restored directory ${directory.path}`);
      await lutimes(restoredDirectory, modified, modified);
      await assertPhysicalDirectory(staging, restoredDirectory, `Restored directory ${directory.path}`);
    }
  }
  lease.assertHeld();
  await writeJsonAtomic(staging, restoredStatePath, restoredStateTemporaryPath, restoredState(manifest, destination, 'complete', manifestSha256, plan));
  await verifyRestoredTree(staging, manifest, destination, 'complete', manifestSha256, plan);
  signal?.throwIfAborted();
  if (pathIdentity(await prospectivePhysicalPath(destination, 'Restore destination')) !== pathIdentity(destination)) {
    throw new Error('Restore destination parent changed before publication');
  }
  lease.assertHeld();
  await rename(staging, destination);
  return { destination, manifest, mediaAccessVerified: false, resumed, alreadyRestored: false, reusedFiles };
}

export async function restoreRemoteStatePackage(directory, options) {
  const manifest = await verifyStatePackage(directory);
  return restoreRemoteAssets({ ...options, directory: path.resolve(directory), manifest });
}
