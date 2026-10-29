import assert from 'node:assert/strict';
import { link, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tableDefinition } from '../../../../src/database/model.js';
import { idKey, mapRecord } from '../../../../src/library/records.js';
import { describeFile } from '../../../../tools/validation/inventory.js';
import { functionalJson } from '../real-dvd-current/scenario.js';
export { functionalJson, libraryOptions, probeValues, technicalDto } from '../real-dvd-current/scenario.js';

const order = values => values.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const fields = (value, names) => Object.fromEntries(names.map(name => [name, value[name] ?? null]));

export async function materializeOriginalBluray(supply, disc) {
  await mkdir(disc);
  for (const member of supply.manifest) {
    const filename = path.join(disc, ...member.path.split('/'));
    if (member.kind === 'directory') await mkdir(filename, { recursive: true });
    else await link(path.join(supply.mediaRoot, ...member.path.split('/')), filename);
  }
  return verifyOriginalBluray(supply, disc);
}

export async function verifyOriginalBluray(supply, disc) {
  const tree = await describeFile(disc), actual = [];
  assert.ok(tree.available && tree.kind === 'directory');
  const walk = (entries, parent = '') => {
    for (const entry of entries) {
      const relative = parent ? parent + '/' + entry.name : entry.name;
      assert.ok(entry.available && ['file', 'directory'].includes(entry.kind));
      actual.push({ path: relative, kind: entry.kind, bytes: entry.kind === 'file' ? entry.bytes : 0,
        ...(entry.kind === 'file' ? { sha256: entry.sha256 } : {}) });
      if (entry.kind === 'directory') walk(entry.entries, relative);
    }
  };
  walk(tree.entries);
  assert.deepEqual(order(actual), supply.manifest, 'The actual scanner must retain every complete original BDMV member and byte.');
  return { entries: actual, sha256: tree.entriesSha256 };
}

export async function configureStorage(root, mediaRoot) {
  const style = process.platform === 'win32' ? 'windows' : 'posix', caseSensitive = style === 'posix';
  const ancestors = path.join(root, 'empty-ancestors'); await mkdir(ancestors);
  const mountContract = { mounts: [{ mountId: 'real-bluray-instance', identityRoot: root, accessRoot: '/bluray-instance',
    pathStyle: style, caseSensitive, returnPolicy: 'required' }] };
  const filename = path.join(root, 'storage.json');
  await writeFile(filename, JSON.stringify({
    instances: [{ id: 'instance', type: 'local', config: { root, writable: true } },
      { id: 'disc', type: 'local', config: { root: mediaRoot, writable: false } },
      { id: 'ancestors', type: 'local', config: { root: ancestors, writable: false } }],
    mounts: [{ path: '/bluray-instance', instanceId: 'instance', capabilities: {
      create: true, replace: true, mkdir: true, delete: true, rename: true, atomicReplace: true } },
    { path: '/bluray-instance/media', instanceId: 'disc', capabilities: {} },
    { path: '/empty-ancestors', instanceId: 'ancestors', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/bluray-instance', style, caseSensitive,
      returnAccess: 'Actual Blu-ray and isolated instance identities remain fixed throughout the exchange.' }],
    ignorePrefixes: [{ identityRoot: path.parse(root).root, accessRoot: '/empty-ancestors', style, caseSensitive,
      returnAccess: 'Only explicitly empty ancestors belong to this isolated Blu-ray scan.' }],
  }, null, 2) + '\n', { flag: 'wx' });
  return { filename, mountContract };
}

export async function discRows(database, disc) {
  const rows = await database.rows('BaseItems', { where: { Path: disc } });
  assert.equal(rows.length, 1, 'The complete Blu-ray directory must produce one actual scanned Movie.');
  const row = rows[0], item = mapRecord(row);
  assert.equal(item.Type, 'Movie'); assert.equal(item.VideoType === 'BluRay' || item.VideoType === 3, true);
  assert.equal(item.IsFolder, false); assert.ok(item.RunTimeTicks > 0); assert.ok(item.Width > 0 && item.Height > 0);
  const relations = {};
  for (const table of ['MediaStreamInfos', 'AttachmentStreamInfos', 'Chapters']) relations[table] =
    await database.rows(table, { where: { ItemId: row.Id } });
  assert.ok(relations.MediaStreamInfos.some(stream => stream.StreamType === 1), 'The real Blu-ray must persist an actual video stream.');
  const technical = { item: { ...fields(item, ['Name', 'SortName', 'Path', 'MediaType', 'RunTimeTicks', 'Size', 'Width', 'Height',
    'TotalBitrate', 'Container', 'Timestamp', 'Video3DFormat', 'HasSubtitles', 'ProductionYear']), Id: idKey(item.Id), VideoType: 'BluRay' },
    relations: Object.fromEntries(Object.entries(relations).map(([name, values]) => [name, values.map(value =>
      Object.fromEntries(tableDefinition(name).columns.filter(column => !column.generated).map(column =>
        [column.name, column.name === 'ItemId' ? idKey(value[column.name]) : value[column.name]])))])) };
  return { row, relations, technical: functionalJson(technical) };
}
