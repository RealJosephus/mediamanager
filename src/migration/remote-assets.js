import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, lstat, realpath, unlink } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { StorageError, checkAbort } from '../storage/errors.js';
import { normalizePath } from '../storage/paths.js';

const kinds = new Set(['nfo', 'subtitle', 'lyric', 'image', 'playlist', 'attachment', 'plugin-state']);
const remotePlans = new WeakMap();
const safeRelative = value => typeof value === 'string' && value && !/[\\:\0]/u.test(value) && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..');
const safeAssetId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value);
const sha256Pattern = /^[a-f0-9]{64}$/u;
const pathsCollide = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
const normalizeThrown = (value, label) => value instanceof Error ? value : new Error(`${label}: ${String(value)}`, { cause: value });
const physicalIdentity = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const sameObject = (left, right) => left.dev === right.dev && left.ino === right.ino;
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

async function bindDirectory(filename, label) {
  let before;
  try { before = await lstat(filename, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`${label} is missing.`, { cause: error }); throw error; }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${label} is not a regular package directory.`);
  const physical = await realpath(filename);
  const after = await lstat(filename, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameObject(before, after)) {
    throw new Error(`${label} changed while it was bound.`);
  }
  return { filename: path.resolve(filename), physical: path.resolve(physical), metadata: after, label };
}

async function assertDirectoryBinding(binding) {
  const current = await lstat(binding.filename, { bigint: true });
  if (!current.isDirectory() || current.isSymbolicLink() || !sameObject(binding.metadata, current)
    || physicalIdentity(await realpath(binding.filename)) !== physicalIdentity(binding.physical)) {
    throw new Error(`${binding.label} changed while it was in use.`);
  }
}

async function bindDirectoryChain(root, parts, { create = false, label }) {
  const bindings = [root];
  let current = root.filename;
  for (const part of parts) {
    current = path.join(current, part);
    if (create) {
      await assertDirectoryBindings(bindings);
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const binding = await bindDirectory(current, label);
    if (!inside(root.physical, binding.physical)) throw new Error(`${label} escapes its bound root.`);
    bindings.push(binding);
  }
  await assertDirectoryBindings(bindings);
  return bindings;
}

async function assertDirectoryBindings(bindings) {
  for (const binding of bindings) await assertDirectoryBinding(binding);
}

async function removeBoundTemporaryFile(filename, metadata, bindings) {
  try {
    await assertDirectoryBindings(bindings);
    const current = await lstat(filename, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || !sameObject(metadata, current)) return;
    await unlink(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function validateRemoteAssetManifest(files) {
  if (!Array.isArray(files)) throw new Error('Remote state asset manifest is required.');
  const result = [], assetIds = new Set(), virtualPaths = new Set(), localPaths = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).sort().join(',') !== 'bytes,modifiedAt,path,remote,sha256'
      || !safeRelative(file.path) || !file.path.startsWith('remote-assets/')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !sha256Pattern.test(file.sha256)
      || (file.modifiedAt !== null && (typeof file.modifiedAt !== 'string' || Number.isNaN(Date.parse(file.modifiedAt))
        || new Date(file.modifiedAt).toISOString() !== file.modifiedAt))) throw new Error('Invalid remote state asset declaration.');
    const remote = file.remote;
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)
      || Object.keys(remote).some(key => !['assetId', 'virtualPath', 'version', 'kind'].includes(key))
      || Object.keys(remote).length !== 4 || !safeAssetId(remote.assetId) || !kinds.has(remote.kind)
      || typeof remote.version !== 'string' || !remote.version) throw new Error('Invalid remote state asset declaration.');
    const assetId = remote.assetId;
    const virtualPath = normalizePath(remote.virtualPath);
    const localPath = file.path.toLowerCase();
    if (virtualPath !== remote.virtualPath || assetIds.has(assetId)) throw new Error('Duplicate or non-canonical remote state asset ID.');
    if (virtualPaths.has(virtualPath)) throw new Error('Duplicate remote state virtual path.');
    if (localPaths.has(localPath)) throw new Error('Duplicate remote state asset path.');
    assetIds.add(assetId); virtualPaths.add(virtualPath); localPaths.add(localPath); result.push(file);
  }
  return result;
}

async function digestRemote(vfs, virtualPath, version, signal, { maxBytes, expectedBytes } = {}) {
  const handle = await vfs.openRead(virtualPath, { ifMatch: version, signal });
  try {
    if (handle.version !== version) throw new Error('Remote asset did not honor its version precondition.');
    const digest = createHash('sha256');
    let bytes = 0n;
    for await (const chunk of handle.stream) {
      checkAbort(signal); digest.update(chunk); bytes += BigInt(chunk.length);
      if (maxBytes != null && bytes > maxBytes) throw new Error('Remote asset exceeds the capture limit.');
      if (expectedBytes != null && bytes > expectedBytes) throw new Error('Remote state asset size differs from its bound generation.');
    }
    if (handle.contentLength != null && handle.contentLength !== bytes) throw new StorageError('invalid-response', 'Remote asset read was truncated.');
    if (expectedBytes != null && bytes !== expectedBytes) throw new Error('Remote state asset size differs from its bound generation.');
    return { sha256: digest.digest('hex'), bytes };
  } finally { await handle.close(); }
}

async function readBoundLocalAsset(filesRootBinding, file, maxAssetBytes) {
  if (file.bytes > maxAssetBytes) throw new Error('Remote state asset exceeds the restore limit.');
  const parts = file.path.split('/'), filename = path.resolve(filesRootBinding.filename, ...parts);
  const bindings = await bindDirectoryChain(filesRootBinding, parts.slice(0, -1), {
    label: 'Remote state asset parent',
  });
  const pathMetadata = await lstat(filename, { bigint: true });
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) throw new Error('Remote state asset payload is not the declared regular file.');
  const physical = await realpath(filename);
  if (!inside(filesRootBinding.physical, physical)) {
    throw new Error('Remote state asset path escapes the package files directory.');
  }
  const handle = await open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    const rebound = await lstat(filename, { bigint: true });
    if (!before.isFile() || before.size !== BigInt(file.bytes) || rebound.isSymbolicLink()
      || !rebound.isFile() || !sameObject(pathMetadata, before) || !sameObject(before, rebound)
      || !inside(filesRootBinding.physical, await realpath(filename))) {
      throw new Error('Remote state asset payload changed before it could be opened safely.');
    }
    await assertDirectoryBindings(bindings);
    const payload = Buffer.allocUnsafe(file.bytes);
    let offset = 0;
    while (offset < payload.length) {
      const { bytesRead } = await handle.read(payload, offset, payload.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1), extraRead = (await handle.read(extra, 0, 1, offset)).bytesRead;
    const after = await handle.stat({ bigint: true });
    const generation = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');
    if (generation(before) !== generation(after)) throw new Error('Remote state asset payload changed while it was read.');
    await assertDirectoryBindings(bindings);
    if (offset !== file.bytes || extraRead) throw new Error('Remote state asset payload size changed while it was read.');
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');
    if (payloadSha256 !== file.sha256) throw new Error('Remote state asset payload checksum mismatch.');
    return payload;
  } finally { await handle.close(); }
}

/** Resolve and bind the current versions of explicit remote sidecars before package capture starts. */
export async function inspectRemoteAssets({ vfs, assets, signal, maxAssetBytes = 256 * 1024 * 1024 }) {
  if (!vfs || !Array.isArray(assets)) throw new TypeError('Remote assets require a VFS and explicit inventory.');
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) throw new TypeError('Invalid remote asset size limit.');
  const planned = [], restorePaths = [], assetIds = new Set(), virtualPaths = new Set();
  for (const asset of assets) {
    checkAbort(signal);
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
      || Object.keys(asset).some(key => !['assetId', 'virtualPath', 'restorePath', 'kind'].includes(key)) || Object.keys(asset).length !== 4
      || !safeAssetId(asset.assetId) || !kinds.has(asset.kind) || !safeRelative(asset.restorePath)) {
      throw new TypeError('Remote assets require only a canonical asset ID, virtual path, sidecar kind and safe restore path.');
    }
    const virtualPath = normalizePath(asset.virtualPath);
    const restoreKey = asset.restorePath.toLowerCase(), assetKey = asset.assetId;
    if (restorePaths.some(existing => pathsCollide(existing, restoreKey))) throw new Error('Colliding remote asset restore path.');
    if (assetIds.has(assetKey)) throw new Error('Duplicate remote state asset ID.');
    if (virtualPaths.has(virtualPath)) throw new Error('Duplicate remote state virtual path.');
    restorePaths.push(restoreKey); assetIds.add(assetKey); virtualPaths.add(virtualPath);
    const metadata = await vfs.stat(virtualPath, { signal });
    if (metadata.kind !== 'file') throw new Error('Only remote sidecar files may be captured.');
    if (!vfs.capabilities(virtualPath).reliableVersion || typeof metadata.version !== 'string' || !metadata.version) throw new Error('Remote state consistency requires reliable conditional object versions represented as nonempty strings.');
    if (metadata.size != null && metadata.size > BigInt(maxAssetBytes)) throw new Error('Remote asset exceeds the capture limit.');
    const inspected = await digestRemote(vfs, virtualPath, metadata.version, signal, {
      maxBytes: BigInt(maxAssetBytes), expectedBytes: metadata.size,
    });
    if (inspected.bytes > BigInt(maxAssetBytes)) throw new Error('Remote asset exceeds the capture limit.');
    if (metadata.size != null && metadata.size !== inspected.bytes) throw new Error('Remote state asset was truncated.');
    planned.push({ ...asset, virtualPath, version: metadata.version, size: inspected.bytes,
      sha256: inspected.sha256, modified: metadata.modified });
  }
  const description = Object.freeze(planned.map(asset => Object.freeze({ assetId: asset.assetId, virtualPath: asset.virtualPath,
    restorePath: asset.restorePath, kind: asset.kind, version: asset.version,
    size: asset.size.toString(), sha256: asset.sha256,
    modifiedAt: asset.modified == null ? null : new Date(asset.modified).toISOString() })));
  const plan = Object.freeze({ assets: description });
  remotePlans.set(plan, { vfs, planned, maxAssetBytes });
  return plan;
}

/** Capture explicit sidecar assets; media bytes are never inferred from a root. */
export async function captureRemoteAssets(options) {
  const allowed = new Set(['vfs', 'assets', 'destination', 'signal', 'maxAssetBytes', 'plan']);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.has(key))) {
    throw new TypeError('Invalid remote asset capture options.');
  }
  const { destination, signal } = options;
  if (typeof destination !== 'string' || !destination) throw new TypeError('Remote asset capture requires a package destination.');
  const plan = options.plan ?? await inspectRemoteAssets(options);
  const bound = remotePlans.get(plan);
  if (!bound) throw new TypeError('A branded remote asset inspection plan is required.');
  if (options.plan && (options.vfs !== undefined || options.assets !== undefined || options.maxAssetBytes !== undefined)) {
    throw new TypeError('A remote asset plan cannot be combined with unbound capture inputs.');
  }
  const { vfs, planned, maxAssetBytes } = bound;
  const destinationBinding = await bindDirectory(path.resolve(destination), 'Remote state capture destination');
  const filesRoot = await bindDirectory(path.join(destinationBinding.filename, 'files'), 'Remote state capture files directory');
  if (!inside(destinationBinding.physical, filesRoot.physical)) {
    throw new Error('Remote state capture files directory escapes the package destination.');
  }
  const result = [];
  for (const asset of planned) {
    const relative = `remote-assets/${asset.restorePath}`;
    const parts = relative.split('/');
    const bindings = await bindDirectoryChain(filesRoot, parts.slice(0, -1), {
      create: true,
      label: 'Remote state capture asset parent',
    });
    await assertDirectoryBinding(destinationBinding);
    const filename = path.join(filesRoot.filename, ...parts);
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.mediamanager-tmp-${randomUUID()}`);
    const output = await open(temporary, 'wx', 0o600);
    const temporaryMetadata = await output.stat({ bigint: true });
    let handle, thrown;
    const digest = createHash('sha256');
    let bytes = 0;
    try {
      try { handle = await vfs.openRead(asset.virtualPath, { ifMatch: asset.version, signal }); }
      catch (error) {
        if (error.code === 'version-changed') throw new Error('Remote state changed during generation capture.', { cause: error });
        throw error;
      }
      if (handle.version !== asset.version) throw new Error('Remote asset did not honor its version precondition.');
      for await (const chunk of handle.stream) {
        checkAbort(signal);
        bytes += chunk.length;
        if (bytes > maxAssetBytes) throw new Error('Remote asset exceeds the capture limit.');
        digest.update(chunk);
        await output.writeFile(chunk);
      }
      if (asset.size != null && BigInt(bytes) !== asset.size || handle.contentLength != null && BigInt(bytes) !== handle.contentLength) throw new Error('Remote state asset was truncated.');
    } catch (error) {
      thrown = normalizeThrown(error, 'Remote asset capture failed');
    } finally {
      const closed = await Promise.allSettled([output.close(), handle?.close()]);
      const closeErrors = closed.filter(item => item.status === 'rejected').map(item => normalizeThrown(item.reason, 'Remote asset capture close failed'));
      if (closeErrors.length) thrown = thrown
        ? new AggregateError([thrown, ...closeErrors], 'Remote asset capture and cleanup failed', { cause: thrown })
        : closeErrors.length === 1 ? closeErrors[0] : new AggregateError(closeErrors, 'Remote asset capture cleanup failed');
    }
    if (thrown) {
      try { await removeBoundTemporaryFile(temporary, temporaryMetadata, bindings); }
      catch (cleanupError) {
        throw new AggregateError([thrown, normalizeThrown(cleanupError, 'Remote asset temporary cleanup failed')],
          'Remote asset capture and temporary cleanup failed', { cause: thrown });
      }
      throw thrown;
    }
    const capturedSha256 = digest.digest('hex');
    try {
      const completedMetadata = await lstat(temporary, { bigint: true });
      if (!completedMetadata.isFile() || completedMetadata.isSymbolicLink()
        || !sameObject(temporaryMetadata, completedMetadata) || completedMetadata.size !== BigInt(bytes)) {
        throw new Error('Remote state capture temporary file changed before publication.');
      }
      await assertDirectoryBindings(bindings);
      await assertDirectoryBinding(destinationBinding);
      if (BigInt(bytes) !== asset.size || capturedSha256 !== asset.sha256) throw new Error('Remote state changed during generation capture.');
      let published = false;
      try {
        await link(temporary, filename);
        published = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          await readBoundLocalAsset(filesRoot, {
            path: relative,
            bytes,
            sha256: capturedSha256,
          }, maxAssetBytes);
        } catch (existingError) {
          throw new Error('Remote state capture target differs from the bound generation.', { cause: existingError });
        }
      }
      if (published) {
        const publishedMetadata = await lstat(filename, { bigint: true });
        if (!publishedMetadata.isFile() || publishedMetadata.isSymbolicLink()
          || !sameObject(temporaryMetadata, publishedMetadata)) {
          throw new Error('Remote state capture target changed during atomic publication.');
        }
      }
      await assertDirectoryBindings(bindings);
      await assertDirectoryBinding(destinationBinding);
      await removeBoundTemporaryFile(temporary, temporaryMetadata, bindings);
      result.push({ path: relative, bytes, sha256: capturedSha256, modifiedAt: asset.modified == null ? null : new Date(asset.modified).toISOString(),
        remote: { assetId: asset.assetId, virtualPath: asset.virtualPath, version: asset.version, kind: asset.kind } });
    } catch (error) {
      try { await removeBoundTemporaryFile(temporary, temporaryMetadata, bindings); }
      catch (cleanupError) {
        throw new AggregateError([normalizeThrown(error, 'Remote asset publication failed'), normalizeThrown(cleanupError, 'Remote asset temporary cleanup failed')],
          'Remote asset publication and temporary cleanup failed', { cause: error });
      }
      throw error;
    }
  }
  await verifyRemoteGeneration(vfs, result, signal);
  return result;
}

export async function verifyRemoteGeneration(vfs, files, signal) {
  for (const file of validateRemoteAssetManifest(files)) {
    checkAbort(signal);
    const current = await vfs.stat(file.remote.virtualPath, { signal });
    if (current.version !== file.remote.version || current.kind !== 'file') throw new Error('Remote state changed during generation capture.');
    const digest = await digestRemote(vfs, file.remote.virtualPath, current.version, signal, {
      maxBytes: BigInt(file.bytes), expectedBytes: BigInt(file.bytes),
    });
    if (digest.bytes !== BigInt(file.bytes) || digest.sha256 !== file.sha256) throw new Error('Remote state changed during generation capture.');
  }
}

/** Restore to explicit new remote targets; partial progress is returned on errors. */
export async function restoreRemoteAssets(options) {
  const allowed = new Set(['directory', 'manifest', 'vfs', 'targets', 'signal', 'maxAssetBytes']);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !allowed.has(key))) {
    throw new TypeError('Invalid remote restore options.');
  }
  const { directory, manifest, vfs, targets, signal, maxAssetBytes = 256 * 1024 * 1024 } = options;
  if (typeof directory !== 'string' || !directory || !vfs || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) {
    throw new TypeError('Remote restore requires a package directory, VFS and positive asset size limit.');
  }
  const files = validateRemoteAssetManifest(manifest.remoteAssets);
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)
    || Object.keys(targets).length !== files.length
    || Object.keys(targets).some(assetId => !safeAssetId(assetId) || !files.some(file => file.remote.assetId === assetId))
    || files.some(file => !Object.hasOwn(targets, file.remote.assetId))) {
    throw new TypeError('Remote restore targets must use the canonical manifest asset IDs.');
  }
  const operations = [], seen = [];
  for (const file of files) {
    const target = normalizePath(targets?.[file.remote.assetId]);
    if (seen.some(existing => pathsCollide(existing, target))) throw new Error('Duplicate remote restore target or ancestor/descendant collision.');
    seen.push(target);
    const capabilities = vfs.capabilities(target);
    if (!capabilities.create || !capabilities.replace || !capabilities.conditionalWrite || !capabilities.atomicReplace || !capabilities.reliableVersion) throw new Error('Remote restore requires create, atomic conditional replace and reliable versions.');
    let current;
    try { current = await vfs.stat(target, { signal }); }
    catch (error) { if (error.code !== 'not-found') throw error; }
    if (current) {
      if (current.kind !== 'file' || typeof current.version !== 'string' || !current.version) throw new Error('Remote restore target is not a versioned file.');
      if (current.size != null && current.size !== BigInt(file.bytes)) throw new Error('Remote restore refuses to overwrite different target content.');
      let digest;
      try { digest = await digestRemote(vfs, target, current.version, signal, { maxBytes: BigInt(file.bytes) }); }
      catch (error) {
        if (/exceeds the capture limit|size differs from its bound generation/u.test(error?.message ?? '')) {
          throw new Error('Remote restore refuses to overwrite different target content.', { cause: error });
        }
        throw error;
      }
      if (digest.sha256 !== file.sha256 || digest.bytes !== BigInt(file.bytes)) throw new Error('Remote restore refuses to overwrite different target content.');
    }
    operations.push({ file, target, existed: Boolean(current) });
  }
  let filesRoot;
  try { filesRoot = await bindDirectory(path.resolve(directory, 'files'), 'Remote state package files directory'); }
  catch (error) {
    if (error.cause?.code === 'ENOENT') throw new Error('Remote state package files directory is missing.', { cause: error });
    throw error;
  }
  for (const operation of operations) {
    try { await readBoundLocalAsset(filesRoot, operation.file, maxAssetBytes); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('Remote state asset payload is missing.', { cause: error }); throw error; }
  }
  const progress = { generation: manifest.generation, completed: [], complete: false };
  try {
    for (const { file, target, existed } of operations) {
      checkAbort(signal);
      if (!existed) {
        const payload = await readBoundLocalAsset(filesRoot, file, maxAssetBytes);
        const written = await vfs.write(target, payload, { size: BigInt(file.bytes), overwrite: false, atomic: true, signal });
        let writtenSize;
        try { writtenSize = BigInt(written?.size); } catch {}
        if (!written || written.atomic !== true || writtenSize !== BigInt(file.bytes)) {
          throw new Error('Remote restore target did not confirm an atomic complete write.');
        }
      }
      const current = await vfs.stat(target, { signal });
      if (typeof current.version !== 'string' || !current.version) throw new Error('Remote restore target did not return a string object version.');
      const digest = await digestRemote(vfs, target, current.version, signal, {
        maxBytes: BigInt(file.bytes), expectedBytes: BigInt(file.bytes),
      });
      if (digest.sha256 !== file.sha256 || digest.bytes !== BigInt(file.bytes)) throw new Error('Remote restore verification failed.');
      progress.completed.push({ assetId: file.remote.assetId, target, version: current.version, sha256: digest.sha256, reused: existed });
    }
    progress.complete = true;
    return progress;
  } catch (thrown) {
    const error = normalizeThrown(thrown, 'Remote restore failed');
    error.remoteRestoreProgress = progress;
    throw error;
  }
}
