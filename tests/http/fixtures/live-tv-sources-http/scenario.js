import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SqliteDatabase } from '../../../../src/database/sqlite.js';
import { md5Guid } from '../../../../src/core/identity.js';
import { dateTicks } from '../../../../src/library/records.js';
import { guideChannelId } from '../../../../src/library/live-tv-guide-channel.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const idKey = value => String(value).replaceAll('-', '').toLowerCase();
export const tables = ['BaseItems', 'AncestorIds', 'UserData', 'Permissions', 'Preferences', 'BaseItemImageInfos',
  'BaseItemProviders', 'BaseItemMetadataFields', 'ItemValues', 'ItemValuesMap', 'LinkedChildren', 'MediaStreamInfos'];
export const databaseFilename = root => path.join(root, 'data/data/jellyfin.db');
export const snapshot = async database => Object.fromEntries(await Promise.all(tables.map(async table => [table, await database.rows(table)])));
export async function sqliteSnapshot(root) {
  const source = new SqliteDatabase(databaseFilename(root), { readOnly: true, requireMigrationHistory: true });
  try { return await snapshot(source); } finally { source.close(); }
}
export const bytesDescription = bytes => ({ length: bytes.length, sha256: sha(bytes), base64: bytes.toString('base64') });
export async function fileDescription(filename) {
  try { return { exists: true, ...bytesDescription(await readFile(filename)) }; }
  catch (cause) { if (cause.code === 'ENOENT') return { exists: false }; throw cause; }
}
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const stamp = value => value.toISOString().replace(/[-:TZ]/gu, '').slice(0, 14) + ' +0000';
export async function prepareSources(root, input) {
  await mkdir(root, { recursive: true });
  const playlist = path.join(root, 'source.m3u'), guide = path.join(root, 'guide.xml'), clock = new Date(); clock.setUTCMilliseconds(0);
  const start = new Date(clock.getTime() + 86400000), end = new Date(start.getTime() + 7200000);
  const m3u = '#EXTM3U\n' + input.channels.map(channel => '#EXTINF:-1 tvg-id="' + channel.guideId + '" tvg-chno="'
    + channel.number + '",' + channel.name + '\n' + channel.url + '\n').join('');
  const document = '<?xml version="1.0" encoding="UTF-8"?><tv>' + input.channels.map(channel => '<channel id="' + channel.providerId
    + '"><display-name>' + xml(channel.providerName) + '</display-name></channel>').join('')
    + input.channels.map(channel => '<programme channel="' + channel.providerId + '" start="' + stamp(start) + '" stop="' + stamp(end) + '">'
      + '<title>' + xml(channel.title) + '</title><desc>Controlled programme overview 中文</desc><category>' + channel.category + '</category></programme>').join('') + '</tv>';
  await writeFile(playlist, m3u, { flag: 'wx' }); await writeFile(guide, document, { flag: 'wx' });
  return { root, playlist, guide, start: start.toISOString(), end: end.toISOString(),
    channels: input.channels.map(channel => { const externalId = 'm3u_' + md5Guid(playlist) + md5Guid(channel.url);
      return { ...channel, externalId, internalId: guideChannelId('Emby', externalId) }; }),
    files: { playlist: bytesDescription(Buffer.from(m3u)), guide: bytesDescription(Buffer.from(document)) } };
}
export const initialConfiguration = days => '<LiveTvOptions><GuideDays>' + days + '</GuideDays><TunerHosts /><ListingProviders /></LiveTvOptions>';
export async function stateFiles(root, cachePath, sources) {
  const files = { configuration: await fileDescription(path.join(root, 'config/livetv.xml')),
    timers: await fileDescription(path.join(root, 'data/data/livetv/timers.json')),
    seriesTimers: await fileDescription(path.join(root, 'data/data/livetv/seriestimers.json')),
    playlist: await fileDescription(sources.playlist), guide: await fileDescription(sources.guide),
    retainedSeed: await fileDescription(sources.retainedSeed),
    countries: await fileDescription(path.join(cachePath, 'sd-countries.json')),
    sentinel: await fileDescription(path.join(path.dirname(cachePath), 'data/source-sentinel_channels')) };
  const cache = {};
  for (const directory of ['', 'xmltv']) {
    let names; try { names = await readdir(path.join(cachePath, directory)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    for (const name of names.sort()) if (directory === 'xmltv' ? /\.xml(?:\.tmp)?$/u.test(name) : name.endsWith('_channels')) {
      const relative = directory ? directory + '/' + name : name;
      cache[relative] = await fileDescription(path.join(cachePath, directory, name));
    }
  }
  const tasks = {};
  for (const name of (await readdir(path.join(root, 'config/ScheduledTasks'))).filter(value => value.endsWith('.js')).sort()) {
    tasks[name] = await fileDescription(path.join(root, 'config/ScheduledTasks', name));
  }
  return { ...files, cache, tasks };
}
export function storageDocument(root) {
  const style = process.platform === 'win32' ? 'windows' : 'posix';
  return { instances: [{ id: 'source-fixture', type: 'local', config: { root, writable: false } }],
    mounts: [{ path: '/source-fixture', instanceId: 'source-fixture', root: '/', capabilities: {} }],
    prefixes: [{ identityRoot: root, accessRoot: '/source-fixture', style, caseSensitive: style !== 'windows', purpose: 'library',
      returnAccess: 'The same controlled source files remain readable by native and Node.' }] };
}
export const portableMountContract = root => ({ mounts: [{ mountId: 'source-fixture', identityRoot: root,
  accessRoot: '/source-fixture', pathStyle: process.platform === 'win32' ? 'windows' : 'posix',
  caseSensitive: process.platform !== 'win32', returnPolicy: 'required' }] });

const creationDates = new Set(['DateCreated', 'DateModified', 'DateLastSaved', 'DateLastRefreshed', 'DateLastMediaAdded']);
const guidPattern = /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/iu;
export function canonical(value, { ids = {}, clock, key } = {}) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(entry => canonical(entry, { ids, clock }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, entry]) => [name, canonical(entry, { ids, clock, key: name })]));
  if (typeof value !== 'string') return value;
  if (key === 'Data') { try { return canonical(JSON.parse(value), { ids, clock }); } catch { return value; } }
  if (key === 'traceId') { assert.ok(value); return '$trace'; }
  if (/Date/u.test(key ?? '') && /^\d{4}-\d\d-\d\d[ T]/u.test(value)) {
    const ticks = dateTicks(value);
    if (clock && creationDates.has(key) && ticks >= BigInt(clock.start) * 10000n + 621355968000000000n
      && ticks < BigInt(clock.end + 1) * 10000n + 621355968000000000n) return '$observed-clock';
    return { ticks: ticks.toString() };
  }
  if (guidPattern.test(value)) return ids[idKey(value)] ?? idKey(value);
  return value;
}
export const stable = value => JSON.stringify(value);
export function canonicalRows(values, options) {
  const ids = { ...options?.ids };
  if (options?.inheritedItemValueIds) {
    const identities = new Set();
    for (const row of values.ItemValues) {
      const identity = JSON.stringify([row.Type, row.Value]); assert.ok(!identities.has(identity), 'ItemValues (Type, Value) must identify one actual row.'); identities.add(identity);
      assert.ok(guidPattern.test(row.ItemValueId));
      if (!options.inheritedItemValueIds.has(idKey(row.ItemValueId))) ids[idKey(row.ItemValueId)] = '$item-value:' + identity;
    }
    const actual = new Set(values.ItemValues.map(row => idKey(row.ItemValueId)));
    for (const row of values.ItemValuesMap) assert.ok(actual.has(idKey(row.ItemValueId)), 'A captured item-value relation must resolve its actual unique referent.');
  }
  return Object.fromEntries(Object.entries(values).map(([table, rows]) => [table, rows.map(row => stable(canonical(row, { ...options, ids }))).sort()]));
}
