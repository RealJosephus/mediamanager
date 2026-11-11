import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverInstanceState, validateInstanceStateSnapshot } from './instance-state.js';
import { rebaseSystemConfiguration } from './instance-system-configuration.js';

const pathKey = value => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
const pathsOverlap = (left, right) => {
  const relative = path.relative(left, right);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
};
const generation = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(':');

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function exactKeys(value, keys, label) {
  plainRecord(value, label);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`Invalid ${label}`);
}

async function assertMissing(filename, label) {
  try {
    const metadata = await lstat(filename);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${filename}`);
    throw new Error(`${label} already exists: ${filename}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function canonicalParent(destination) {
  const parent = path.dirname(destination);
  let metadata;
  try { metadata = await lstat(parent); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`The isolated instance clone parent does not exist: ${parent}`);
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error(`The isolated instance clone parent must not be a symbolic link: ${parent}`);
  if (!metadata.isDirectory()) throw new Error(`The isolated instance clone parent must be a directory: ${parent}`);
  if (pathKey(await realpath(parent)) !== pathKey(parent)) throw new Error(`The isolated instance clone parent uses a path alias: ${parent}`);
  return parent;
}

async function canonicalProspectivePath(value) {
  const resolved = path.resolve(value), suffix = [];
  let existing = resolved, metadata;
  for (;;) {
    try { metadata = await lstat(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('The isolated output has no existing filesystem ancestor');
      suffix.unshift(path.basename(existing)); existing = parent;
    }
  }
  if (suffix.length && metadata.isSymbolicLink()) throw new Error('The isolated output parent must not be a symbolic link or junction');
  if (suffix.length && !metadata.isDirectory()) throw new Error('The isolated output parent is not a directory');
  const physical = path.resolve(await realpath(existing), ...suffix);
  if (pathKey(physical) !== pathKey(resolved)) throw new Error('The isolated output must not be a symbolic link or use a junction parent');
  return physical;
}

/** Resolve an unwritten output and prove it is physically disjoint from every discovered source root. */
export async function assertIsolatedInstanceOutput(options) {
  exactKeys(options, ['instanceState', 'output'], 'isolated instance output options');
  const source = validateInstanceStateSnapshot(options.instanceState);
  if (typeof options.output !== 'string' || !options.output) throw new Error('An isolated instance output path is required');
  const output = await canonicalProspectivePath(options.output);
  for (const sourceRoot of new Set([source.instanceRoot, ...Object.values(source.roots)])) {
    if (pathsOverlap(sourceRoot, output) || pathsOverlap(output, sourceRoot)) {
      throw new Error(`The isolated output overlaps a source root: ${sourceRoot}`);
    }
  }
  return output;
}

async function copyTree(source, target, context) {
  const before = await lstat(source, { bigint: true });
  if (before.isSymbolicLink()) throw new Error(`Stopped Jellyfin instance contains a symbolic link: ${source}`);
  if (!before.isDirectory()) throw new Error(`Stopped Jellyfin instance root must be a directory: ${source}`);
  await mkdir(target, { recursive: false, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(target, 0o700);
  const entries = (await readdir(source, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const sourceChild = path.join(source, entry.name), targetChild = path.join(target, entry.name);
    const childBefore = await lstat(sourceChild, { bigint: true });
    if (childBefore.isSymbolicLink()) throw new Error(`Stopped Jellyfin instance contains a symbolic link: ${sourceChild}`);
    if (childBefore.isDirectory()) await copyTree(sourceChild, targetChild, context);
    else if (childBefore.isFile()) {
      if (sourceChild === context.systemPath) {
        const content = rebaseSystemConfiguration(await readFile(sourceChild), context.rebasedPaths);
        await writeFile(targetChild, content, { flag: 'wx', mode: 0o600 });
        await chmod(targetChild, Number(childBefore.mode & 0o777n));
      } else await copyFile(sourceChild, targetChild, constants.COPYFILE_EXCL);
      const childAfter = await lstat(sourceChild, { bigint: true });
      if (generation(childBefore) !== generation(childAfter)) throw new Error(`Stopped Jellyfin instance changed while it was copied: ${sourceChild}`);
      await utimes(targetChild, Number(childBefore.atimeNs) / 1e9, Number(childBefore.mtimeNs) / 1e9);
    } else throw new Error(`Stopped Jellyfin instance contains an unsupported filesystem entry: ${sourceChild}`);
  }
  const after = await lstat(source, { bigint: true });
  if (generation(before) !== generation(after)) throw new Error(`Stopped Jellyfin instance changed while it was copied: ${source}`);
  await utimes(target, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
  if (process.platform !== 'win32') context.directories.push({ filename: target, mode: Number(before.mode & 0o777n) });
}

async function isOwnedCloneDirectory(directory, identity) {
  let current;
  try { current = await lstat(directory, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!identity || !current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`The isolated clone directory changed before cleanup: ${directory}`);
  }
  return true;
}

async function removeOwnedClone(root, identity, sealedDirectories) {
  if (!await isOwnedCloneDirectory(root, identity)) return;
  for (const directory of sealedDirectories.toReversed()) {
    const filename = path.join(root, directory.relative);
    if (await isOwnedCloneDirectory(filename, directory.identity)) await chmod(filename, 0o700);
  }
  await rm(root, { recursive: true, force: true });
}

function clonedBindingPath(destination, roots, binding) {
  const root = roots[binding.root];
  if (!root) throw new Error(`The stopped Jellyfin instance has an unknown configured path root: ${binding.root}`);
  const value = path.join(root, ...binding.relativePath.split('/').filter(Boolean));
  if (!inside(destination, value)) throw new Error('A configured Jellyfin path would escape the isolated clone');
  return value;
}

function assertCloneState(source, cloned, destination, expectedRoots) {
  if (pathKey(cloned.instanceRoot) !== pathKey(destination) || cloned.identity.serverId !== source.identity.serverId) {
    throw new Error('The isolated Jellyfin clone identity does not match its source');
  }
  const expectedLabels = Object.keys(source.roots).sort(), actualLabels = Object.keys(cloned.roots).sort();
  if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
    throw new Error('The isolated Jellyfin clone roots do not match its source');
  }
  for (const label of expectedLabels) {
    if (pathKey(cloned.roots[label]) !== pathKey(expectedRoots[label]) || !inside(destination, cloned.roots[label])) {
      throw new Error(`The isolated Jellyfin clone root is outside its destination: ${label}`);
    }
  }
  for (const name of ['metadata', 'cache']) {
    const expected = source.pathBindings[name], actual = cloned.pathBindings[name];
    if (actual.configured !== expected.configured || actual.root !== expected.root || actual.relativePath !== expected.relativePath) {
      throw new Error(`The isolated Jellyfin clone ${name} path binding does not match its source`);
    }
  }
}

/**
 * Clone a caller-held, stopped Jellyfin instance into a new self-contained directory.
 * The caller must keep the source stopped for the duration; discovery generations detect
 * source changes but cannot stop a process owned by the caller.
 */
export async function cloneStoppedInstance(options) {
  exactKeys(options, ['instanceState', 'destination'], 'stopped Jellyfin instance clone options');
  const source = validateInstanceStateSnapshot(options.instanceState);
  if (typeof options.destination !== 'string' || !options.destination) throw new Error('An isolated instance clone destination is required');
  const destination = await assertIsolatedInstanceOutput({ instanceState: source, output: options.destination });
  const parent = await canonicalParent(destination);
  await assertMissing(destination, 'The isolated instance clone destination');

  const current = await discoverInstanceState({ instanceRoot: source.instanceRoot });
  if (current.identity.digest !== source.identity.digest) throw new Error('The stopped Jellyfin source state is no longer current');

  const temporary = path.join(parent, `.${path.basename(destination)}.mediamanager-clone-${randomUUID()}`);
  const temporaryRoots = Object.fromEntries(Object.keys(source.roots).map(label => [label, path.join(temporary, label)]));
  const finalRoots = Object.fromEntries(Object.keys(source.roots).map(label => [label, path.join(destination, label)]));
  let temporaryCreated = false, published = false, temporaryIdentity;
  const sealedDirectories = [];
  try {
    await mkdir(temporary, { recursive: false });
    temporaryCreated = true;
    temporaryIdentity = await lstat(temporary, { bigint: true });
    const rebasedPaths = {};
    for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
      const binding = source.pathBindings[name];
      if (!binding.configured) continue;
      rebasedPaths[field] = clonedBindingPath(destination, finalRoots, binding);
    }
    const context = { directories: [], rebasedPaths,
      systemPath: Object.keys(rebasedPaths).length ? path.join(source.roots.config, 'system.xml') : undefined };
    for (const [label, sourceRoot] of Object.entries(source.roots)) await copyTree(sourceRoot, temporaryRoots[label], context);

    const after = await discoverInstanceState({ instanceRoot: source.instanceRoot });
    if (after.identity.digest !== source.identity.digest) throw new Error('The stopped Jellyfin source state changed while it was copied');
    for (const { filename, mode } of context.directories) {
      if ((mode & 0o700) !== 0o700) sealedDirectories.push({
        relative: path.relative(temporary, filename), identity: await lstat(filename, { bigint: true }),
      });
      await chmod(filename, mode);
    }
    await assertMissing(destination, 'The isolated instance clone destination');
    await rename(temporary, destination);
    published = true;

    const cloned = await discoverInstanceState({ instanceRoot: destination });
    assertCloneState(source, cloned, destination, finalRoots);
    return cloned;
  } catch (error) {
    if (published || temporaryCreated) {
      try { await removeOwnedClone(published ? destination : temporary, temporaryIdentity, sealedDirectories); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Stopped Jellyfin instance clone failed and its partial output could not be removed', { cause: error });
      }
    }
    throw error;
  }
}
