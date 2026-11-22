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
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';

export const stateDirectory = '.mediamanager-exchange';
export async function hasImportedMarkerReader(instance) {
  let manifest;
  try {
    manifest = await readFile(path.join(instance, stateDirectory, 'manifest.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const lineage = JSON.parse(manifest);
  return lineage.version === 1 && lineage.owner === 'jellyfin' && lineage.embyChapterMarkers === true;
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
  return before;
}
export async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value) + '\n', { mode: 0o600 });
}
export async function verifyState(root, kind) {
  const state = path.join(root, stateDirectory);
  if (!(await exists(state))) return null;
  await directory(state);
  const meta = JSON.parse(await readFile(path.join(state, 'manifest.json'), 'utf8'));
  if (meta.version !== 1 || meta.owner !== kind) throw new Error('Invalid migration lineage');
  const anchor = await readFile(path.join(state, 'base.json'));
  if (hash(anchor) !== meta.baseHash) throw new Error('Migration field baseline has changed');
  const origin = path.join(state, 'origin');
  await directory(origin);
  if (hash(JSON.stringify(await inventory(origin))) !== meta.originHash)
    throw new Error('Migration origin files have changed');
  const external = meta.assetHash ? path.join(state, 'source-metadata') : null;
  if (external && hash(JSON.stringify(await inventory(external))) !== meta.assetHash)
    throw new Error('Captured external metadata has changed');
  return { origin, external, originIdentity: meta.originIdentity, base: JSON.parse(anchor) };
}
export async function sealState(
  root,
  owner,
  source,
  originIdentity,
  sourceRows,
  targetRows,
  assets,
  aliases,
  external,
  importedMarkerReader,
) {
  const state = path.join(root, stateDirectory);
  await mkdir(state, { mode: 0o700 });
  const captured = await cloneDirectory(source, path.join(state, 'origin'), { skipState: true });
  const assetHash = external
    ? hash(JSON.stringify(await cloneDirectory(external, path.join(state, 'source-metadata'))))
    : undefined;
  const base = { chapterMarkerVersion: 1, source: [...sourceRows], target: [...targetRows], assets, aliases };
  await writeJson(path.join(state, 'base.json'), base);
  await writeJson(path.join(state, 'manifest.json'), {
    version: 1,
    owner,
    originIdentity,
    ...(importedMarkerReader ? { embyChapterMarkers: true } : {}),
    originHash: hash(JSON.stringify(captured)),
    assetHash,
    baseHash: await fileHash(path.join(state, 'base.json')),
  });
}
export async function mergeAssets(from, to, oldA = {}, oldB = {}, report) {
  const a = (await exists(from)) ? await inventory(from) : { members: {}, directories: [] };
  const b = (await exists(to)) ? await inventory(to) : { members: {}, directories: [] };
  if (a.directories.length || Object.keys(a.members).length) await mkdir(to, { recursive: true, mode: 0o700 });
  for (const d of a.directories) await mkdir(path.join(to, d), { recursive: true, mode: 0o700 });
  for (const name of new Set([...Object.keys(oldA), ...Object.keys(a.members)])) {
    const get = (members) => (Object.hasOwn(members, name) ? members[name] : undefined);
    const input = get(a.members),
      current = get(b.members);
    if (input === get(oldA) || input === current) continue;
    if (current !== get(oldB)) {
      report('conflict', 'asset', name, 'bytes', 'target asset changed');
      continue;
    }
    const target = path.join(to, name);
    if (input) {
      await mkdir(path.dirname(target), { recursive: true });
      const source = path.join(from, name);
      await copyFile(source, target);
      const stat = await lstat(source);
      await utimes(target, stat.atime, stat.mtime);
      if ((await fileHash(target)) !== input) throw new Error('Asset changed during migration: ' + name);
    } else if (current) await unlink(target);
  }
  return { source: a.members, target: (await exists(to)) ? (await inventory(to)).members : {} };
}
