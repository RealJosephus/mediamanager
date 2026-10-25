import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverInstanceState, validateInstanceStateSnapshot } from './instance-state.js';

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

async function copyTree(source, target) {
  const before = await lstat(source, { bigint: true });
  if (before.isSymbolicLink()) throw new Error(`Stopped Jellyfin instance contains a symbolic link: ${source}`);
  if (!before.isDirectory()) throw new Error(`Stopped Jellyfin instance root must be a directory: ${source}`);
  await mkdir(target, { recursive: false, mode: Number(before.mode & 0o777n) });
  const entries = (await readdir(source, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const sourceChild = path.join(source, entry.name), targetChild = path.join(target, entry.name);
    const childBefore = await lstat(sourceChild, { bigint: true });
    if (childBefore.isSymbolicLink()) throw new Error(`Stopped Jellyfin instance contains a symbolic link: ${sourceChild}`);
    if (childBefore.isDirectory()) await copyTree(sourceChild, targetChild);
    else if (childBefore.isFile()) {
      await copyFile(sourceChild, targetChild, constants.COPYFILE_EXCL);
      const childAfter = await lstat(sourceChild, { bigint: true });
      if (generation(childBefore) !== generation(childAfter)) throw new Error(`Stopped Jellyfin instance changed while it was copied: ${sourceChild}`);
      await utimes(targetChild, Number(childBefore.atimeNs) / 1e9, Number(childBefore.mtimeNs) / 1e9);
    } else throw new Error(`Stopped Jellyfin instance contains an unsupported filesystem entry: ${sourceChild}`);
  }
  const after = await lstat(source, { bigint: true });
  if (generation(before) !== generation(after)) throw new Error(`Stopped Jellyfin instance changed while it was copied: ${source}`);
  await utimes(target, Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
}

function clonedBindingPath(destination, roots, binding) {
  const root = roots[binding.root];
  if (!root) throw new Error(`The stopped Jellyfin instance has an unknown configured path root: ${binding.root}`);
  const value = path.join(root, ...binding.relativePath.split('/').filter(Boolean));
  if (!inside(destination, value)) throw new Error('A configured Jellyfin path would escape the isolated clone');
  return value;
}

function rewriteConfiguredPath(xml, field, value) {
  const expression = new RegExp(`<${field}>([\\s\\S]*?)<\\/${field}>`, 'gu');
  if ([...xml.matchAll(expression)].length !== 1) {
    throw new Error(`Configured Jellyfin ${field} must have exactly one simple XML element`);
  }
  const escaped = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return xml.replace(expression, `<${field}>${escaped}</${field}>`);
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
  let temporaryCreated = false, published = false;
  try {
    await mkdir(temporary, { recursive: false });
    temporaryCreated = true;
    for (const [label, sourceRoot] of Object.entries(source.roots)) await copyTree(sourceRoot, temporaryRoots[label]);

    const systemPath = path.join(temporaryRoots.config, 'system.xml');
    let system = await readFile(systemPath, 'utf8'), changed = false;
    for (const [name, field] of [['metadata', 'MetadataPath'], ['cache', 'CachePath']]) {
      const binding = source.pathBindings[name];
      if (!binding.configured) continue;
      system = rewriteConfiguredPath(system, field, clonedBindingPath(destination, finalRoots, binding));
      changed = true;
    }
    if (changed) await writeFile(systemPath, system, { flag: 'w' });

    const after = await discoverInstanceState({ instanceRoot: source.instanceRoot });
    if (after.identity.digest !== source.identity.digest) throw new Error('The stopped Jellyfin source state changed while it was copied');
    await assertMissing(destination, 'The isolated instance clone destination');
    await rename(temporary, destination);
    published = true;

    const cloned = await discoverInstanceState({ instanceRoot: destination });
    assertCloneState(source, cloned, destination, finalRoots);
    return cloned;
  } catch (error) {
    if (published || temporaryCreated) {
      try { await rm(published ? destination : temporary, { recursive: true, force: true }); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Stopped Jellyfin instance clone failed and its partial output could not be removed', { cause: error });
      }
    }
    throw error;
  }
}
