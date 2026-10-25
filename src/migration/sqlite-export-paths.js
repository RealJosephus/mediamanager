import { NativeTextCell, nativeTextCell } from '../database/native-text.js';
import path from 'node:path';
import { tokenizeJson } from '../core/json-tokens.js';
import { nativeModel } from '../database/model.js';
import { projectPortableJellyfinPath } from '../storage/portable-mount-contract.js';

const directPathColumns = Object.freeze(new Map([
  ['BaseItemImageInfos', ['Path']],
  ['BaseItems', ['Path']],
  ['Chapters', ['ImagePath']],
  ['ImageInfos', ['Path']],
  ['MediaStreamInfos', ['Path']],
]));

// These rows identify Jellyfin-owned instance state, not media. Their paths
// may be absolute in older/native databases and must never force callers to
// advertise the local data directory as a portable media mount.
const instanceStatePathColumns = new Set([
  'Chapters.ImagePath',
  'ImageInfos.Path',
]);

const instanceStateBaseItemTypes = new Set([
  'AggregateFolder',
  'BasePluginFolder',
  'CollectionFolder',
  'ManualPlaylistsFolder',
  'PlaylistsFolder',
  'UserRootFolder',
  'UserView',
]);

const dataPathArrays = new Set([
  'AdditionalParts',
  'AudioFiles',
  'LocalAlternateVersions',
  'LyricFiles',
  'PhysicalLocationsList',
  'SubtitleFiles',
]);

const selfLocatedFolderTypes = new Set([
  'MediaBrowser.Controller.Entities.AggregateFolder',
  'MediaBrowser.Controller.Entities.CollectionFolder',
]);

const nonzeroGuidPattern = /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function directPathOptions(tableName, column, row) {
  if (instanceStatePathColumns.has(`${tableName}.${column}`)) {
    return { allowInternalPath: true, instanceState: true };
  }
  if (column !== 'Path') return {};
  // Both repositories can contain Jellyfin-owned generated metadata as an
  // absolute legacy path. Rewrite values that do belong to a media mount, but
  // do not force unrelated instance-state paths into that contract.
  if (tableName === 'BaseItemImageInfos') return {
    allowInternalPath: true, allowInstanceState: true, protocolPolicy: 'http', requireMount: false,
  };
  if (tableName === 'MediaStreamInfos') return {
    allowInternalPath: true, allowInstanceState: true, requireMount: false,
  };
  if (tableName === 'BaseItems') return {
    allowInternalPath: true,
    instanceState: instanceStateBaseItemTypes.has(row.Type?.split('.').at(-1)),
    // Jellyfin channel/live-TV items can natively identify their stream with a
    // supported remote playback protocol. Ordinary library items remain
    // filesystem-semantic and must map through the portable mount contract.
    protocolPolicy: nonzeroGuidPattern.test(row.ChannelId) ? 'media' : 'none',
  };
  return {};
}

function canonicalInstanceStateRoots(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'metadata,programData') {
    throw new TypeError('instanceStatePaths must contain exactly programData and metadata');
  }
  const result = {};
  for (const key of ['programData', 'metadata']) {
    if (typeof value[key] !== 'string' || value[key].includes('\0') || !path.isAbsolute(value[key])) {
      throw new TypeError(`instanceStatePaths.${key} must be an absolute path`);
    }
    result[key] = path.resolve(value[key]);
  }
  return result;
}

function virtualInstanceStatePath(value, roots) {
  if (!roots || typeof value !== 'string' || !path.isAbsolute(value)) return value;
  // Match Jellyfin's ReverseVirtualPath ordering: its program-data replacement
  // precedes the (possibly external) internal-metadata replacement.
  for (const [key, token] of [['programData', '%AppDataPath%'], ['metadata', '%MetadataPath%']]) {
    const relative = path.relative(roots[key], path.resolve(value));
    if (relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      return relative === '' ? token : `${token}${path.sep}${relative}`;
    }
  }
  return value;
}

function propertyNodes(node, name) {
  return node?.properties?.filter(([key]) => key === name).map(([, value]) => value) ?? [];
}

function stringNode(node, label, project, replacements, { nullable = true, ...options } = {}) {
  if (node.value === null && nullable) return;
  if (typeof node.value !== 'string') throw new Error(`${label} is not a string path`);
  const replacement = project(node.value, label, options);
  if (replacement !== node.value) replacements.push({ start: node.start, end: node.end, value: JSON.stringify(replacement) });
}

function projectImagePath(value, label, project, options) {
  if (typeof value !== 'string' || !value.includes('|')) return project(value, label, options);
  return value.split('|').map((candidate, index) => project(candidate, `${label}[${index}]`, options)).join('|');
}

function projectBaseItemData(value, project, label, { physicalLocationOwnerPath, instanceRoots } = {}) {
  if (value == null) return value;
  if (typeof value !== 'string') throw new TypeError(`${label} must be JSON text`);
  let root;
  // Jellyfin deliberately tolerates opaque/legacy Data values when a row
  // cannot be deserialized. There is no sound way to interpret paths in such
  // a value, so retain its exact text instead of corrupting an R7 exchange.
  try { JSON.parse(value); root = tokenizeJson(value); }
  catch { return value; }
  if (!root.properties) return value;
  const replacements = [];
  for (const property of dataPathArrays) for (const node of propertyNodes(root, property)) {
    if (node.value === null) continue;
    if (!node.items) throw new Error(`${label}.${property} is not a path array`);
    for (const [index, item] of node.items.entries()) {
      // Root folder resolution includes its own configuration directory alongside
      // the media targets read from its shortcuts. Only that exact owner path
      // belongs to instance state; every other location still needs a mount.
      const owner = property === 'PhysicalLocationsList' && typeof physicalLocationOwnerPath === 'string'
        && typeof item.value === 'string'
        && virtualInstanceStatePath(item.value, instanceRoots) === virtualInstanceStatePath(physicalLocationOwnerPath, instanceRoots);
      stringNode(item, `${label}.${property}[${index}]`, project, replacements,
        owner ? { instanceState: true, allowInternalPath: true } : {});
    }
  }
  for (const node of propertyNodes(root, 'LinkedAlternateVersions')) {
    if (node.value === null) continue;
    if (!node.items) throw new Error(`${label}.LinkedAlternateVersions is not an array`);
    for (const [index, item] of node.items.entries()) {
      if (!item.properties) throw new Error(`${label}.LinkedAlternateVersions[${index}] is not an object`);
      for (const pathNode of propertyNodes(item, 'Path')) {
        stringNode(pathNode, `${label}.LinkedAlternateVersions[${index}].Path`, project, replacements);
      }
    }
  }
  // Remote shortcut URLs are a native Jellyfin media contract (for example a
  // .strm item), not a VFS backend leak. Filesystem shortcut values are still
  // mapped and internal VFS access paths are still rejected.
  for (const node of propertyNodes(root, 'ShortcutPath')) {
    stringNode(node, `${label}.ShortcutPath`, project, replacements, { protocolPolicy: 'media' });
  }
  replacements.sort((left, right) => right.start - left.start);
  let output = value;
  for (const replacement of replacements) output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  return output;
}

export function createSqliteExportPathProjector({ sourceContract = null, targetContract = sourceContract,
  instanceStatePaths = null } = {}) {
  const instanceRoots = canonicalInstanceStateRoots(instanceStatePaths);
  const statistics = { auditedPaths: 0, rewrittenPaths: 0 };
  const project = (value, label, options = {}) => {
    if (value == null || value === '') return value;
    statistics.auditedPaths += 1;
    const { instanceState = false, allowInstanceState = false, ...pathOptions } = options;
    const instanceProjected = instanceState || allowInstanceState
      ? virtualInstanceStatePath(value, instanceRoots) : value;
    const projected = projectPortableJellyfinPath(instanceProjected, sourceContract,
      instanceState ? sourceContract : targetContract, {
      label,
      requireMount: sourceContract !== null,
      ...pathOptions,
      ...(instanceState ? { requireMount: false } : {}),
    });
    if (projected !== value) statistics.rewrittenPaths += 1;
    return projected;
  };
  const projectStringRow = (tableName, row) => {
    let result = row;
    const assign = (key, value) => {
      if (value === row[key]) return;
      if (result === row) result = { ...row };
      result[key] = value;
    };
    for (const column of directPathColumns.get(tableName) ?? []) {
      const label = `${tableName}.${column}`;
      const options = directPathOptions(tableName, column, row);
      assign(column, tableName === 'BaseItemImageInfos' && column === 'Path'
        ? projectImagePath(row[column], label, project, options)
        : project(row[column], label, options));
    }
    if (tableName === 'BaseItems') {
      assign('Data', projectBaseItemData(row.Data, project, 'BaseItems.Data', {
        physicalLocationOwnerPath: selfLocatedFolderTypes.has(row.Type) ? row.Path : undefined,
        instanceRoots,
      }));
    }
    return result;
  };
  const projectRow = (tableName, row) => {
    const fields = [...(directPathColumns.get(tableName) ?? []), ...(tableName === 'BaseItems' ? ['Type', 'ChannelId', 'Data'] : [])];
    const semantic = { ...row }, opaque = new Set();
    for (const key of fields) {
      const value = row[key];
      if (value == null) continue;
      if (!(value instanceof NativeTextCell)) throw new TypeError('Path projection requires raw native TEXT cells.');
      try { semantic[key] = value.string(); }
      catch (error) {
        if (key !== 'Data') throw error;
        opaque.add(key); semantic[key] = null;
      }
    }
    const projected = projectStringRow(tableName, semantic);
    let result = row;
    for (const key of fields) {
      if (opaque.has(key) || projected[key] === semantic[key]) continue;
      if (result === row) result = { ...row };
      result[key] = projected[key] == null ? projected[key] : nativeTextCell(projected[key]);
    }
    return result;
  };
  return {
    projectRow,
    statistics: () => Object.freeze({ ...statistics }),
  };
}

/** Audit and, when an explicit target contract differs, rewrite a newly-created
 * SQLite export in one transaction. No runtime PostgreSQL row is mutated. */
export async function rewriteSqliteExportPaths(database, options = {}) {
  if (database?.dialect !== 'sqlite') throw new TypeError('SQLite export path rewriting requires a SQLite target');
  const { batchSize: requestedBatchSize = 128, signal } = options;
  if (!Number.isSafeInteger(requestedBatchSize) || requestedBatchSize < 1) throw new TypeError('SQLite export path rewrite batchSize must be positive');
  const batchSize = Math.min(requestedBatchSize, 128);
  const projector = createSqliteExportPathProjector(options);
  database.database.exec('BEGIN IMMEDIATE');
  try {
    for (const [tableName, columns] of directPathColumns) {
      const table = nativeModel.tables.find(candidate => candidate.name === tableName);
      let offset = 0;
      for (;;) {
        signal?.throwIfAborted();
        const rows = await database.rows(tableName, { limit: batchSize, offset, consumer: 'exchange' });
        for (const row of rows) {
          const projected = projector.projectRow(tableName, row);
          if (projected !== row) {
            const changes = {};
            for (const column of [...columns, ...(tableName === 'BaseItems' ? ['Data'] : [])]) {
              if (projected[column] !== row[column]) changes[column] = projected[column];
            }
            if (Object.keys(changes).length) {
              await database.update(tableName, Object.fromEntries(table.primaryKey.map(key => [key, row[key]])), changes);
            }
          }
        }
        offset += rows.length;
        if (rows.length < batchSize) break;
      }
    }
    database.database.exec('COMMIT');
  } catch (error) {
    database.database.exec('ROLLBACK');
    throw error;
  }
  return projector.statistics();
}
