import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  constants,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  readFile,
  rm,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';

export const stateDirectory = '.mediamanager-exchange';
export async function readEmbyImportManifest(instance) {
  let manifest;
  try {
    manifest = await readFile(path.join(instance, stateDirectory, 'manifest.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const lineage = JSON.parse(manifest);
  return [1, 2].includes(lineage.version) && lineage.owner === 'jellyfin' ? lineage : null;
}
export async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
export function inside(parent, file) {
  const relative = path.relative(parent, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}
export async function directory(root) {
  const resolved = path.resolve(root),
    stat = await lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(await realpath(resolved), resolved) !== '')
    throw new Error('An ordinary directory is required: ' + resolved);
  return resolved;
}
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function fileHash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function list(root, { skipState = false } = {}) {
  const files = [],
    directories = [];
  async function walk(relative) {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (skipState && !relative && entry.name === stateDirectory) continue;
      if (entry.name === '.' || entry.name === '..' || entry.name.includes('\\') || entry.name.includes(':'))
        throw new Error('Non-portable member: ' + entry.name);
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink())
        throw new Error('An explicit physical root is required for linked member: ' + name);
      if (entry.isDirectory()) {
        directories.push(name);
        await walk(name);
      } else if (entry.isFile()) files.push(name);
      else throw new Error('Unsupported filesystem entry: ' + name);
    }
  }
  await walk('');
  return { files, directories };
}
export async function inventory(root, options) {
  const { files, directories } = await list(root, options);
  const members = Object.create(null);
  for (const file of files)
    Object.defineProperty(members, file, { value: await fileHash(path.join(root, file)), enumerable: true });
  return { directories, members };
}
async function restoreDirectoryAttributes(source, target) {
  const stat = await lstat(source);
  await chmod(target, stat.mode & 0o7777);
  await utimes(target, stat.atimeMs / 1000, stat.mtimeMs / 1000);
}
export async function cloneDirectory(source, destination, { skipState = false } = {}) {
  await directory(source);
  if (inside(source, destination) || inside(destination, source))
    throw new Error('Source and destination overlap');
  const before = await inventory(source, { skipState });
  await mkdir(destination, { recursive: false, mode: 0o700 });
  for (const name of before.directories) await mkdir(path.join(destination, name), { mode: 0o700 });
  for (const [name, sha] of Object.entries(before.members)) {
    const from = path.join(source, name),
      to = path.join(destination, name),
      stat = await lstat(from);
    await copyFile(from, to, constants.COPYFILE_EXCL);
    if ((await fileHash(to)) !== sha) throw new Error('Source changed while copying ' + name);
    await chmod(to, stat.mode & 0o777);
    await utimes(to, stat.atime, stat.mtime);
  }
  const after = await inventory(source, { skipState });
  if (JSON.stringify(after) !== JSON.stringify(before))
    throw new Error('Source generation changed during migration');
  // Creating children changes their parent's mtime. Restore permissions and
  // times from the leaves up, after all destination entries exist.
  for (const name of ['', ...before.directories].reverse()) {
    await restoreDirectoryAttributes(path.join(source, name), path.join(destination, name));
  }
  return before;
}
export async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}
// The manifest authenticates base.json, which in turn binds the order and
// content of each endpoint's chunks. Only the private publication stage writes them.
export async function writeRowChunks(state, endpoint, rows) {
  const hashes = [], records = [];
  let bytes = 0;
  async function flush() {
    const chunk = Buffer.from('[' + records.join(',') + ']\n');
    await writeFile(path.join(state, endpoint + '-' + hashes.length + '.json'), chunk, { mode: 0o600, flag: 'wx' });
    hashes.push(hash(chunk));
    bytes = 0;
    records.length = 0;
  }
  for (const row of rows) {
    const record = JSON.stringify(row);
    records.push(record);
    bytes += Buffer.byteLength(record) + 1;
    if (bytes >= 2 * 1024 * 1024) await flush();
  }
  if (records.length) await flush();
  return hashes;
}

async function* readRowChunks(state, endpoint, hashes) {
  if (!Array.isArray(hashes)) throw new Error('Invalid migration row chunk manifest');
  for (const [index, expected] of hashes.entries()) {
    const chunk = await readFile(path.join(state, endpoint + '-' + index + '.json'));
    if (hash(chunk) !== expected) throw new Error('Migration field baseline has changed');
    yield* JSON.parse(chunk);
  }
}

export async function openExchangeState(root, kind) {
  const state = path.join(root, stateDirectory);
  if (!(await exists(state))) return null;
  await directory(state);
  const meta = JSON.parse(await readFile(path.join(state, 'manifest.json'), 'utf8'));
  if (![1, 2].includes(meta.version) || meta.owner !== kind) throw new Error('Invalid migration lineage');
  const anchor = await readFile(path.join(state, 'base.json'));
  if (hash(anchor) !== meta.baseHash) throw new Error('Migration field baseline has changed');
  const origin = path.join(state, 'origin');
  await directory(origin);
  if (hash(JSON.stringify(await inventory(origin))) !== meta.originHash)
    throw new Error('Migration origin files have changed');
  const external = meta.assetHash ? path.join(state, 'source-metadata') : null;
  if (external && hash(JSON.stringify(await inventory(external))) !== meta.assetHash)
    throw new Error('Captured external metadata has changed');
  const base = JSON.parse(anchor);
  const { source, target, ...baseFields } = base;
  const endpoints = { source, target };
  return { origin, external, originIdentity: meta.originIdentity, base: baseFields,
    rows: endpoint => meta.version === 2 ? readRowChunks(state, endpoint, endpoints[endpoint]) : endpoints[endpoint] };
}

export async function verifyState(root, kind) {
  const state = await openExchangeState(root, kind);
  if (!state) return null;
  const { rows, ...verified } = state;
  for (const endpoint of ['source', 'target']) verified.base[endpoint] = await Array.fromAsync(rows(endpoint));
  return verified;
}
export async function sealState(
  root,
  owner,
  source,
  originIdentity,
  rowChunks,
  assets,
  aliases,
  external,
  importedMarkerReader,
  providerState,
) {
  const state = path.join(root, stateDirectory);
  const captured = await cloneDirectory(source, path.join(state, 'origin'), { skipState: true });
  const assetHash = external
    ? hash(JSON.stringify(await cloneDirectory(external, path.join(state, 'source-metadata'))))
    : undefined;
  const base = { chapterMarkerVersion: 1, ...rowChunks, assets, aliases, providerState };
  await writeJson(path.join(state, 'base.json'), base);
  await writeJson(path.join(state, 'manifest.json'), {
    version: 2,
    owner,
    originIdentity,
    ...(importedMarkerReader ? { embyChapterMarkers: true } : {}),
    originHash: hash(JSON.stringify(captured)),
    assetHash,
    baseHash: await fileHash(path.join(state, 'base.json')),
  });
}
export function assetInventory(saved = {}) {
  if (Array.isArray(saved.directories)) return saved;
  // Older baselines recorded file digests only. Recover the directories
  // their files prove existed, including intermediate ancestors.
  const directories = new Set();
  for (const name of Object.keys(saved)) {
    for (let parent = path.posix.dirname(name); parent !== '.' && !directories.has(parent); parent = path.posix.dirname(parent)) {
      directories.add(parent);
    }
  }
  return { members: saved, directories: [...directories].sort() };
}

function assetTree(snapshot) {
  const root = new Map(), directories = new Map([['.', root]]);
  for (const name of snapshot.directories) {
    const children = new Map();
    directories.get(path.posix.dirname(name)).set(path.posix.basename(name), { kind: 'directory', children });
    directories.set(name, children);
  }
  for (const [name, digest] of Object.entries(snapshot.members)) {
    directories.get(path.posix.dirname(name)).set(path.posix.basename(name), { kind: 'file', digest });
  }
  return root;
}

function sameAsset(left, right) {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'file') return left.digest === right.digest;
  return left.children.size === right.children.size && [...left.children]
    .every(([name, asset]) => sameAsset(asset, right.children.get(name)));
}

function sourceOwnsTree(current, previousInput, name, include) {
  if (!previousInput || current.kind !== previousInput.kind || !include(name)) return false;
  if (current.kind === 'file') return true;
  return [...current.children].every(([child, asset]) =>
    sourceOwnsTree(asset, previousInput.children.get(child), `${name}/${child}`, include));
}

// A held file, directory, or absent name retains its last acknowledged state.
// A child in conflict can still need its old ancestors after a directory deletion.
function assetReceipt(observed, previous, held, include) {
  if (!held.size) return observed;
  const directories = new Set(), members = Object.create(null);
  const isHeld = name => {
    let included = true;
    for (let part = name; part !== '.'; part = path.posix.dirname(part)) {
      included &&= include(part);
      // Native-only files such as options.xml still document the actual library
      // directory. A retained file at an ancestor cannot also contain children.
      if (held.has(part)) return included || Object.hasOwn(previous.members, part);
    }
    return false;
  };
  for (const [inventory, useHeld] of [[observed, false], [previous, true]]) {
    for (const name of inventory.directories) if (isHeld(name) === useHeld) directories.add(name);
    for (const [name, digest] of Object.entries(inventory.members)) if (isHeld(name) === useHeld) members[name] = digest;
  }
  for (const name of [...directories, ...Object.keys(members)]) {
    for (let dir = path.posix.dirname(name); dir !== '.' && !directories.has(dir); dir = path.posix.dirname(dir)) directories.add(dir);
  }
  return { directories: [...directories].sort(), members };
}

export async function mergeAssets(from, to, oldA, oldB, report, { include = () => true } = {}) {
  const read = async root => (await exists(root)) ? inventory(root) : assetInventory();
  const source = await read(from), target = await read(to);
  const baseSource = assetInventory(oldA), baseTarget = assetInventory(oldB), held = new Set();
  const empty = new Map();
  async function merge(input, current, previousInput, previousTarget, parent = '') {
    for (const child of new Set([...previousInput.keys(), ...input.keys(), ...current.keys(), ...previousTarget.keys()])) {
      const name = parent ? `${parent}/${child}` : child;
      if (!include(name)) continue;
      const a = input.get(child), b = current.get(child);
      const oldSource = previousInput.get(child), oldTarget = previousTarget.get(child);
      const destination = path.join(to, name);
      if (b?.kind === 'directory' && (a?.kind === 'directory' || !a && oldSource?.kind === 'directory')) {
        await merge(a?.children ?? empty, b.children, oldSource?.children ?? empty, oldTarget?.children ?? empty, name);
        if (!a && oldTarget?.kind === 'directory') {
          try { await rmdir(destination); }
          catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        }
        continue;
      }
      if (sameAsset(a, b)) continue;
      if (oldSource?.kind === 'file' && oldTarget?.kind === 'file' && oldSource.digest !== oldTarget.digest) {
        // Older receipts could acknowledge two different byte strings. They
        // cannot establish which edit came first, even if neither side moved.
        held.add(name);
        report('conflict', 'asset', name, 'bytes', 'previous receipt has different digests for the same file');
        continue;
      }
      if (sameAsset(a, oldSource)) {
        if (oldB && !sameAsset(b, oldTarget)) held.add(name);
        continue;
      }
      if (!sameAsset(b, oldTarget) || b?.kind === 'directory' && !sourceOwnsTree(b, oldSource, name, include)) {
        held.add(name);
        report('conflict', 'asset', name, a && b && a.kind !== b.kind ? 'kind' : 'bytes', 'target asset changed or contains independent members');
        continue;
      }
      if (b && a?.kind !== b.kind) {
        if (b.kind === 'directory') await rm(destination, { recursive: true });
        else await unlink(destination);
      }
      if (!a) continue;
      if (a.kind === 'directory') {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await merge(a.children, empty, empty, empty, name);
        await restoreDirectoryAttributes(path.join(from, name), destination);
      } else {
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const filename = path.join(from, name);
        await copyFile(filename, destination);
        const stat = await lstat(filename);
        await utimes(destination, stat.atime, stat.mtime);
        if ((await fileHash(destination)) !== a.digest) throw new Error('Asset changed during migration: ' + name);
      }
    }
  }
  await merge(assetTree(source), assetTree(target), assetTree(baseSource), assetTree(baseTarget));
  return { source: assetReceipt(source, baseSource, held, include), target: assetReceipt(await read(to), baseTarget, held, include) };
}
