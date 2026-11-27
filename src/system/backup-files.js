import path from 'node:path';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { identityPathStyle } from '../storage/uri.js';

const pathApi = identity => identityPathStyle(identity) === 'windows' ? path.win32 : path.posix;
const configFile = name => /\.(?:xml|json)$/iu.test(name);
const portableName = name => name && name !== '.' && name !== '..' && !/[/\\:\x00-\x1f]/u.test(name);

export function backupRoots(paths, options, fileSystem) {
  const { configurationDirectoryPath, programDataPath, dataPath, defaultMetadataPath, metadataPath } = paths;
  const roots = [];
  function add(prefix, root, local = false, topOnly = false) {
    if (root) roots.push({ prefix, root, files: local ? fs : fileSystem, local, topOnly, api: pathApi(root) });
  }
  if (configurationDirectoryPath) {
    add('Config', configurationDirectoryPath, true, true);
    for (const name of ['users', 'ScheduledTasks']) add('Config/' + name, path.join(configurationDirectoryPath, name), true);
  }
  if (programDataPath) add('Root', path.join(programDataPath, 'root'));
  for (const name of ['collections', 'playlists', 'ScheduledTasks',
    ...(options.Subtitles ? ['subtitles'] : []), ...(options.Trickplay ? ['trickplay'] : [])]) {
    add('Data/' + name, path.join(dataPath, name));
  }
  if (options.Metadata) {
    add('Data/metadata', metadataPath);
    if (defaultMetadataPath !== metadataPath) add('Data/metadata-default', defaultMetadataPath);
  }
  return roots;
}

export function backupDestination(roots, key) {
  for (const root of roots) {
    if (!key.startsWith(root.prefix + '/')) continue;
    const parts = key.slice(root.prefix.length + 1).split('/');
    if (root.topOnly && (parts.length !== 1 || !configFile(parts[0]))) continue;
    if (parts.every(portableName)) return { ...root, parts, filename: root.api.join(root.root, ...parts) };
  }
  throw new Error('Backup entry is outside the selected file scopes.');
}

export async function captureBackupFiles(roots, backupDirectory, save) {
  for (const root of roots) {
    async function visit(directory, prefix, optional = false) {
      let entries;
      try {
        if (!(await root.files.lstat(directory)).isDirectory()) throw new Error('Backup source must be a directory.');
        entries = await root.files.readdir(directory, { withFileTypes: true });
      } catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (root.topOnly && (!entry.isFile() || !configFile(entry.name))) continue;
        if (!portableName(entry.name)) throw new Error('A backup filename cannot be represented in this archive.');
        const filename = root.api.join(directory, entry.name), key = prefix + '/' + entry.name;
        if (!root.api.relative(backupDirectory, filename)) continue;
        if (entry.isDirectory()) { await visit(filename, key); continue; }
        if (!entry.isFile()) continue;
        const before = await root.files.stat(filename, { bigint: true });
        const size = await save(key, root.local ? createReadStream(filename) : root.files.createReadStream(filename));
        const after = await root.files.stat(filename, { bigint: true });
        if (BigInt(size) !== before.size || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
          throw new Error('A source file changed during backup.');
        }
      }
    }
    await visit(root.root, root.prefix, true);
  }
}

export async function restoreBackupFile(target, source, size) {
  const { files, api, local, filename } = target;
  const directory = api.dirname(filename);
  if (local) {
    // An existing symlink in the host configuration tree must never redirect a restore.
    let parent = target.root;
    for (const part of ['', ...target.parts.slice(0, -1)]) {
      parent = api.join(parent, part);
      try { if (!(await fs.lstat(parent)).isDirectory()) throw new Error('Invalid backup destination directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await fs.mkdir(parent); }
    }
    const temporary = api.join(directory, '.restore-' + randomUUID());
    try {
      await fs.copyFile(source, temporary, fs.constants.COPYFILE_EXCL);
      await fs.rename(temporary, filename);
    } finally { await fs.rm(temporary, { force: true }); }
  } else {
    await files.mkdir(directory, { recursive: true });
    const input = createReadStream(source);
    try { await files.writeFile(filename, input, { size: BigInt(size), atomic: true }); }
    finally { input.destroy(); }
  }
}
