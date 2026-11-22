import path from 'node:path';
import { copyFile, lstat, mkdir, readFile, readdir, rename, utimes, writeFile } from 'node:fs/promises';
import { readXml, textOf } from '../../core/xml.js';
import { decodeConfigurationXml } from '../../core/configuration-xml.js';
import { ordinalIgnoreCaseKey } from '../../storage/ordinal-comparer.js';
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
const assetKey = (root, name) => pathApi(root.identityRoot) === path.win32 ? ordinalIgnoreCaseKey(name) : name;
function streamIdentity(media, value) {
  if (typeof media !== 'string' || !pathApi(media).isAbsolute(media) || pathApi(value).isAbsolute(value) ||
      /^[%\\/]|[:\u0000]/u.test(value)) return value;
  const api = pathApi(media);
  const segments = value.split(api === path.win32 ? /[\\/]/u : '/');
  return segments.some(part => !part || part === '..' || part === '.') ? value
    : api.join(api.dirname(media), ...segments);
}
function declaredLocation(roots, identity) {
  for (const root of roots) {
    const name = relativeTo(root.identityRoot, identity);
    if (name) return { root, name };
  }
  return null;
}
function companionSubtitle(name, stream) {
  if (/\.idx$/iu.test(name)) return name.slice(0, -4) + '.sub';
  if (/\.sub$/iu.test(name) && /^dvd_?sub(?:title)?$/iu.test(stream.Codec ?? '')) return name.slice(0, -4) + '.idx';
  return null;
}
function referencedFiles(rows, roots) {
  const selected = new Map(roots.map(root => [root.id, new Set()]));
  for (const [key, item] of rows) {
    if (!key.startsWith('item/')) continue;
    for (const stream of item.Streams) {
      if (!stream.IsExternal || typeof stream.Path !== 'string' || !stream.Path) continue;
      const location = declaredLocation(roots, streamIdentity(item.Path, stream.Path));
      if (!location) continue;
      const { root, name } = location;
      selected.get(root.id).add(assetKey(root, name));
      const pair = companionSubtitle(name, stream);
      if (pair) selected.get(root.id).add(assetKey(root, pair));
    }
  }
  return selected;
}
export function assetRoots(value) {
  if (!Array.isArray(value))
    throw new Error('Asset roots must be an array of {id, identityRoot, directory} entries');
  const ids = new Set(), identities = new Set();
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
      const identity = pathApi(entry.identityRoot).resolve(entry.identityRoot);
      const key = assetKey(entry, identity.replace(/[\\/]+$/u, ''));
      if (identities.has(key)) throw new Error('Asset root identity paths must be unique');
      identities.add(key);
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
async function snapshotSidecars(entry, destination, selected, report) {
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
      if (!member.isFile() || (!sidecar.test(member.name) && !selected.has(assetKey(entry, name)))) continue;
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
  const captured = new Map();
  for (const name of first.keys()) {
    const key = assetKey(entry, name);
    if (captured.has(key) && selected.has(key)) throw new Error('Ambiguous referenced file in asset root ' + entry.id + ': ' + name);
    captured.set(key, name);
  }
  return captured;
}
export async function collectAssets({ instance, original, type, stage, override, roots, rows = [], report }) {
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
  const captured = new Map();
  if (extra) {
    if (await exists(active)) {
      if (path.parse(active).root === active)
        throw new Error('A filesystem root cannot be captured as metadata');
      await cloneDirectory(active, stage);
    } else await mkdir(stage, { mode: 0o700 });
    const referenced = referencedFiles(rows, roots);
    for (const entry of roots) captured.set(entry.id,
      await snapshotSidecars(entry, path.join(stage, 'migration-assets', entry.id), referenced.get(entry.id), report));
  }
  return {
    directory: extra ? stage : standard,
    extra,
    identities: [settings.identity, metadataDirectory(original, type)].filter(Boolean),
    roots,
    captured,
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
        const identity = field === 'Streams' ? streamIdentity(row.Path, raw) : raw;
        for (const root of assets.identities) rel ??= relativeTo(root, identity);
        const location = rel == null && declaredLocation(assets.roots, identity);
        if (location) {
          const { root, name } = location;
          const actual = assets.captured.get(root.id)?.get(assetKey(root, name));
          if (actual) rel = 'migration-assets/' + root.id + '/' + actual;
          else if (field === 'Streams')
            report('missing', 'item', key.slice(5), field, 'referenced file unavailable in ' + root.id + ': ' + name);
        }
        if (rel == null && Object.hasOwn(paths, identity)) rel = paths[identity];
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
        if (field === 'Streams') {
          const pair = companionSubtitle(rel, sub);
          if (pair && !(await exists(path.join(assets.directory, pair))))
            report('missing', 'item', key.slice(5), field, 'paired subtitle unavailable: ' + pair);
        }
        if (raw !== targetPath) {
          paths[identity] = rel;
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
