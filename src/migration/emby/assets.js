import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, readdir, rename, utimes, writeFile } from 'node:fs/promises';
import { readXml, textOf } from '../../core/xml.js';
import { decodeConfigurationXml } from '../../core/configuration-xml.js';
import { rebaseSystemConfiguration } from '../instance-system-configuration.js';
import { cloneDirectory, directory, exists, fileHash, inside } from './files.js';

export const metadataDirectory = (root, type) => path.join(root, type === 'emby' ? '' : 'data', 'metadata');
export const libraryRoot = (root, type) => path.join(root, type === 'emby' ? '' : 'data', 'root');
const pathApi = (value) => (/^(?:[a-z]:[\\/]|\\\\)/iu.test(value) ? path.win32 : path.posix);
const sidecar =
  /\.(?:nfo|xml|jpe?g|png|webp|avif|gif|bmp|tiff?|srt|vtt|ass|ssa|sub|idx|sup|lrc|bif|trickplay)$/iu;
function relativeTo(root, value) {
  const api = pathApi(root);
  if (typeof value !== 'string' || pathApi(value) !== api || !api.isAbsolute(value)) return null;
  const rel = api.relative(root, value);
  if (api.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + api.sep)) return null;
  return rel.split(api.sep).join('/');
}
export function assetRoots(value) {
  if (!Array.isArray(value))
    throw new Error('Asset roots must be an array of {id, identityRoot, directory} entries');
  const ids = new Set();
  return value
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(entry.id) ||
        ids.has(entry.id)
      )
        throw new Error('Asset root IDs must be unique portable names');
      if (
        typeof entry.directory !== 'string' ||
        !path.isAbsolute(entry.directory) ||
        typeof entry.identityRoot !== 'string' ||
        !pathApi(entry.identityRoot).isAbsolute(entry.identityRoot)
      )
        throw new Error('Absolute physical directory and media identityRoot required for ' + entry.id);
      ids.add(entry.id);
      return { id: entry.id, identityRoot: entry.identityRoot, directory: path.resolve(entry.directory) };
    })
    .sort((a, b) => b.identityRoot.length - a.identityRoot.length);
}
async function readSetting(instance, type) {
  const file = path.join(instance, 'config', 'system.xml');
  if (!(await exists(file))) return {};
  const bytes = await readFile(file);
  const setting = textOf(readXml(decodeConfigurationXml(bytes)), 'MetadataPath')?.trim();
  if (!setting) return {};
  const api = pathApi(setting);
  if (!api.isAbsolute(setting)) throw new Error('Configured MetadataPath must be absolute');
  return { bytes, file, setting, identity: type === 'emby' ? api.join(setting, 'metadata') : setting };
}
async function snapshotSidecars(entry, destination, report) {
  const root = await directory(entry.directory);
  if (path.parse(root).root === root || inside(root, destination) || inside(destination, root))
    throw new Error('Asset root must be a separate dedicated directory');
  async function walk(rel, collect) {
    const result = new Map();
    for (const member of (await readdir(path.join(root, rel), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (member.name.includes(':') || member.name.includes('\\'))
        throw new Error('Non-portable asset member ' + member.name);
      const name = rel ? rel + '/' + member.name : member.name;
      if (member.isSymbolicLink()) {
        if (collect)
          report(
            'external',
            'asset',
            entry.id + '/' + name,
            'link',
            'provide a physical asset root for this link',
          );
        continue;
      }
      if (member.isDirectory()) {
        for (const [k, v] of await walk(name, collect)) result.set(k, v);
        continue;
      }
      if (!member.isFile() || !sidecar.test(member.name)) continue;
      const from = path.join(root, name),
        to = path.join(destination, name);
      const sha = await fileHash(from);
      result.set(name, sha);
      if (!collect) continue;
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      if ((await exists(to)) && (await fileHash(to)) !== sha)
        throw new Error('Sidecar collides with existing metadata: ' + name);
      const stat = await lstat(from);
      await copyFile(from, to);
      await utimes(to, stat.atime, stat.mtime);
      if ((await fileHash(to)) !== sha) throw new Error('Sidecar changed while copying: ' + name);
    }
    return result;
  }
  const first = await walk('', true);
  if (JSON.stringify([...first]) !== JSON.stringify([...(await walk('', false))]))
    throw new Error('Source sidecars changed during capture');
}
export async function collectAssets({ instance, original, type, stage, override, roots, report }) {
  const standard = metadataDirectory(instance, type),
    settings = await readSetting(instance, type);
  let active = standard;
  if (settings.identity) {
    const local = relativeTo(original, settings.identity);
    if (local !== null && (type !== 'emby' || !inside(original, settings.setting)))
      active = path.join(instance, local);
    else if (type !== 'emby' || !inside(original, settings.setting)) active = settings.identity;
  }
  if (override) active = override;
  if (active !== standard && (!(await exists(active)) || !path.isAbsolute(active)))
    throw new Error(
      'Configured metadata is unavailable. Supply --metadata-root with the stopped physical metadata directory.',
    );
  const extra = active !== standard || roots.length > 0;
  if (extra) {
    if (await exists(active)) {
      if (path.parse(active).root === active)
        throw new Error('A filesystem root cannot be captured as metadata');
      await cloneDirectory(active, stage);
    } else await mkdir(stage, { mode: 0o700 });
    for (const entry of roots)
      await snapshotSidecars(entry, path.join(stage, 'migration-assets', entry.id), report);
  }
  return {
    directory: extra ? stage : standard,
    extra,
    identities: [settings.identity, metadataDirectory(original, type)].filter(Boolean),
    roots,
  };
}
export async function activateMetadata(target, type, effective, unused) {
  const dir = metadataDirectory(target, type),
    setting = await readSetting(target, type);
  if (effective && path.resolve(effective) !== path.resolve(dir)) {
    if (await exists(dir)) await rename(dir, unused);
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
    await cloneDirectory(effective, dir);
  }
  if (setting.setting)
    await writeFile(setting.file, rebaseSystemConfiguration(setting.bytes, { MetadataPath: '' }));
}
// Only path-bearing asset fields participate. Main media file identities remain in the mount contract.
export async function projectAssetRows(rows, assets, report, remembered = {}) {
  const mapped = new Map(),
    paths = { ...remembered },
    changes = [];
  const libraryRoots = new Set(assets.libraryRoots ?? []);
  for (const [key, row] of rows) {
    if (
      key.startsWith('item/') &&
      typeof row.Path === 'string' &&
      pathApi(row.Path).isAbsolute(row.Path) &&
      row.type?.endsWith('.AggregateFolder') &&
      pathApi(row.Path).basename(row.Path).toLowerCase() === 'root'
    )
      libraryRoots.add(row.Path);
  }
  for (const [key, row] of rows) {
    if (!key.startsWith('item/')) {
      mapped.set(key, row);
      continue;
    }
    const result = { ...row },
      fields = [];
    if (
      !row.Path &&
      assets.targetLibrary &&
      path.isAbsolute(assets.targetLibrary) &&
      /\.(?:AggregateFolder|UserRootFolder)$/u.test(row.type)
    ) {
      result.Path = row.type.endsWith('.UserRootFolder')
        ? path.join(assets.targetLibrary, 'default')
        : assets.targetLibrary;
      fields.push('Path');
    }
    if (
      assets.targetLibrary &&
      path.isAbsolute(assets.targetLibrary) &&
      row.type?.endsWith('.CollectionFolder') &&
      (!row.Path || !pathApi(row.Path).isAbsolute(row.Path)) &&
      !/^%RootFolderPath%/iu.test(row.Path ?? '') &&
      typeof row.Name === 'string' &&
      !/[\\/:\x00-\x1f]/u.test(row.Name) &&
      !['.', '..', ''].includes(row.Name)
    ) {
      result.Path = path.join(assets.targetLibrary, 'default', row.Name);
      fields.push('Path');
    }
    if (typeof row.Path === 'string' && assets.targetLibrary) {
      const token = /^%RootFolderPath%(?:[\\/](.*))?$/iu.exec(row.Path);
      let rel = token ? (token[1] ?? '').replaceAll('\\', '/') : null;
      for (const root of libraryRoots) rel ??= relativeTo(root, row.Path);
      if (rel != null) {
        if (rel && rel.split('/').some((s) => !s || s === '.' || s === '..' || /[:\\]/u.test(s)))
          throw new Error('Invalid collection folder path');
        result.Path = rel
          ? assets.targetLibrary + path.sep + rel.split('/').join(path.sep)
          : assets.targetLibrary;
        if (result.Path !== row.Path) fields.push('Path');
      }
    }
    for (const [field, property] of [
      ['Images', 'Path'],
      ['Chapters', 'ImagePath'],
      ['Streams', 'Path'],
    ]) {
      result[field] = [];
      for (const sub of row[field]) {
        const raw = sub[property];
        if (!raw || (field === 'Streams' && !sub.IsExternal)) {
          result[field].push(sub);
          continue;
        }
        let rel;
        const virtual = /^%MetadataPath%[\\/](.+)$/iu.exec(raw);
        if (virtual) rel = virtual[1].replaceAll('\\', '/');
        for (const root of assets.identities) rel ??= relativeTo(root, raw);
        for (const root of assets.roots) {
          const name = relativeTo(root.identityRoot, raw);
          if (rel == null && name && sidecar.test(name)) rel = 'migration-assets/' + root.id + '/' + name;
        }
        if (rel == null && Object.hasOwn(paths, raw)) rel = paths[raw];
        if (rel == null) {
          report('external', 'item', key.slice(5), field, 'file reference retained: ' + raw);
          result[field].push(sub);
          continue;
        }
        if (!rel || rel.split('/').some((s) => !s || s === '.' || s === '..' || /[:\\]/u.test(s)))
          throw new Error('Invalid relative metadata asset: ' + rel);
        const targetPath = '%MetadataPath%' + path.sep + rel.split('/').join(path.sep);
        if (!(await exists(path.join(assets.directory, rel))))
          report('missing', 'item', key.slice(5), field, rel);
        if (raw !== targetPath) {
          paths[raw] = rel;
          if (!fields.includes(field)) fields.push(field);
        }
        result[field].push({ ...sub, [property]: targetPath });
      }
    }
    mapped.set(key, result);
    if (fields.length) changes.push({ key, value: result, fields });
  }
  return { rows: mapped, paths, changes };
}
